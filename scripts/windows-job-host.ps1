param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('run', 'terminate')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$StatePath,

    [Parameter(Mandatory = $true)]
    [string]$JobName,

    [string]$WorkingDirectory,
    [string]$CommandBase64,
    [long]$MemoryBytes = 0,
    [int]$CpuPercent = 0,
    [int]$TtlSeconds = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class McDevJob
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
    const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
    const uint JOB_OBJECT_QUERY = 0x0004;
    const uint JOB_OBJECT_TERMINATE = 0x0008;
    const uint WAIT_OBJECT_0 = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
    {
        public uint ControlFlags;
        public uint CpuRate;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    public sealed class Child : IDisposable
    {
        public IntPtr Handle { get; private set; }
        public int ProcessId { get; private set; }

        internal Child(IntPtr handle, int processId)
        {
            Handle = handle;
            ProcessId = processId;
        }

        public bool HasExited()
        {
            return WaitForSingleObject(Handle, 0) == WAIT_OBJECT_0;
        }

        public uint ExitCode()
        {
            uint exitCode;
            if (!GetExitCodeProcess(Handle, out exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return exitCode;
        }

        public void Dispose()
        {
            if (Handle != IntPtr.Zero)
            {
                CloseHandle(Handle);
                Handle = IntPtr.Zero;
            }
        }
    }

    public static IntPtr Create(string name, long memoryBytes, int cpuPercent)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (memoryBytes > 0)
            {
                limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.JobMemoryLimit = new UIntPtr((ulong)memoryBytes);
            }
            SetJobInfo(job, 9, limits);

            if (cpuPercent > 0 && cpuPercent <= 100)
            {
                var cpu = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
                cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE |
                    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
                cpu.CpuRate = (uint)cpuPercent * 100;
                SetJobInfo(job, 15, cpu);
            }

            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public static Child Start(
        IntPtr job,
        string executable,
        string[] arguments,
        string workingDirectory)
    {
        if (executable == null)
            throw new ArgumentNullException("executable");
        if (arguments == null)
            throw new ArgumentNullException("arguments");
        if (workingDirectory == null)
            throw new ArgumentNullException("workingDirectory");

        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION process;
        var commandLine = new StringBuilder(Quote(executable));
        for (int index = 0; index < arguments.Length; index++)
        {
            if (arguments[index] == null)
                throw new ArgumentNullException("arguments[" + index + "]");
            commandLine.Append(' ');
            commandLine.Append(Quote(arguments[index]));
        }

        bool created = CreateProcess(
            executable,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            false,
            CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP,
            IntPtr.Zero,
            workingDirectory,
            ref startup,
            out process);
        if (!created)
            throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (ResumeThread(process.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return new Child(process.hProcess, (int)process.dwProcessId);
        }
        catch
        {
            TerminateProcess(process.hProcess, 1);
            CloseHandle(process.hProcess);
            throw;
        }
        finally
        {
            CloseHandle(process.hThread);
        }
    }

    public static int[] ProcessIds(IntPtr job)
    {
        int size = 65536;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            uint returned;
            if (!QueryInformationJobObject(job, 3, buffer, (uint)size, out returned))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            int count = Marshal.ReadInt32(buffer, 4);
            var processIds = new List<int>(count);
            int offset = 8;
            for (int index = 0; index < count; index++)
            {
                long value = IntPtr.Size == 8
                    ? Marshal.ReadInt64(buffer, offset + index * IntPtr.Size)
                    : Marshal.ReadInt32(buffer, offset + index * IntPtr.Size);
                processIds.Add((int)value);
            }
            return processIds.ToArray();
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public static void Terminate(string name, uint exitCode)
    {
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
        if (job == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (!TerminateJobObject(job, exitCode))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            CloseHandle(job);
        }
    }

    public static void Close(IntPtr handle)
    {
        if (handle != IntPtr.Zero)
            CloseHandle(handle);
    }

    static void SetJobInfo<T>(IntPtr job, int informationClass, T value)
    {
        int size = Marshal.SizeOf(typeof(T));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(value, pointer, false);
            if (!SetInformationJobObject(job, informationClass, pointer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"', '\\' }) < 0)
            return value;

        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            result.Append(character);
            backslashes = 0;
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr jobObjectInfo,
        uint jobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr jobObjectInfo,
        uint jobObjectInfoLength,
        out uint returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);
}
'@

function Read-ServiceState {
    Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
}

function Write-ServiceState {
    param([object]$State)

    $State.updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $temporaryPath = "$StatePath.$PID.tmp"
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $StatePath -Force
}

function Write-LifecycleLog {
    param(
        [object]$State,
        [string]$Message
    )

    $timestamp = [DateTimeOffset]::UtcNow.ToString('o')
    Add-Content -LiteralPath $State.logPath -Value "$timestamp $Message" -Encoding UTF8
}

if ($Action -eq 'terminate') {
    $state = Read-ServiceState
    $state.stopRequestedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $state.status = 'stopping'
    Write-ServiceState $state
    [McDevJob]::Terminate($JobName, 143)
    exit 0
}

if (-not $WorkingDirectory -or -not $CommandBase64 -or $TtlSeconds -le 0) {
    throw 'run requires WorkingDirectory, CommandBase64, and a positive TtlSeconds value'
}

$commandJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($CommandBase64)
)
[string[]]$command = ConvertFrom-Json -InputObject $commandJson
if ($command.Count -lt 1) {
    throw 'The configured command is empty'
}

$job = [IntPtr]::Zero
$child = $null
$exitCode = [uint32]1
$finalStatus = 'failed'
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TtlSeconds)
$nextSample = [DateTimeOffset]::MinValue

try {
    $job = [McDevJob]::Create($JobName, $MemoryBytes, $CpuPercent)
    $arguments = if ($command.Count -gt 1) {
        [string[]]$command[1..($command.Count - 1)]
    } else {
        [string[]]@()
    }
    $child = [McDevJob]::Start(
        $job,
        [string]$command[0],
        $arguments,
        $WorkingDirectory
    )

    $state = Read-ServiceState
    $state.supervisorPid = $PID
    $state.targetPid = $child.ProcessId
    $state.processIds = @($child.ProcessId)
    $state.status = 'running'
    $state.startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-ServiceState $state
    Write-LifecycleLog $state "started pid=$($child.ProcessId) job=$JobName"

    while (-not $child.HasExited()) {
        $now = [DateTimeOffset]::UtcNow
        if ($now -ge $deadline) {
            Write-LifecycleLog $state "TTL expired after $TtlSeconds seconds"
            [McDevJob]::Terminate($JobName, 124)
            $finalStatus = 'expired'
            break
        }

        if ($now -ge $nextSample) {
            $processIds = @([McDevJob]::ProcessIds($job))
            $memoryBytes = [long]0
            $cpuSeconds = [double]0
            foreach ($processId in $processIds) {
                $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
                if ($null -ne $process) {
                    $memoryBytes += $process.WorkingSet64
                    $cpuSeconds += $process.CPU
                }
            }

            $state.processIds = $processIds
            $state.currentMemoryMb = [Math]::Round($memoryBytes / 1MB, 1)
            $state.peakMemoryMb = [Math]::Max(
                [double]$state.peakMemoryMb,
                [double]$state.currentMemoryMb
            )
            $state.cpuSeconds = [Math]::Round($cpuSeconds, 1)
            $latestState = Read-ServiceState
            if ($latestState.stopRequestedAt) {
                $state.stopRequestedAt = $latestState.stopRequestedAt
                $state.status = $latestState.status
            }
            Write-ServiceState $state
            $nextSample = $now.AddSeconds(2)
        }

        Start-Sleep -Milliseconds 200
    }

    if ($finalStatus -ne 'expired') {
        $exitCode = $child.ExitCode()
        $latestState = Read-ServiceState
        if ($latestState.stopRequestedAt -or $exitCode -eq 143) {
            $finalStatus = 'stopped'
        } elseif ($exitCode -eq 0) {
            $finalStatus = 'stopped'
        }
    } else {
        $exitCode = 124
    }
} catch {
    $state = Read-ServiceState
    Write-LifecycleLog $state "supervisor error: $($_.Exception.Message)"
    throw
} finally {
    if ($null -ne $child) {
        $child.Dispose()
    }
    [McDevJob]::Close($job)

    $state = Read-ServiceState
    $state.status = $finalStatus
    $state.exitCode = [long]$exitCode
    $state.endedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-ServiceState $state
    Write-LifecycleLog $state "ended status=$finalStatus exitCode=$exitCode"
}

if ($finalStatus -eq 'stopped') {
    exit 0
}
exit 1
