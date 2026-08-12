# Security Policy

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/rsocko/mission-control/security/policy)
to send the maintainers a confidential report. On the security policy page,
select **Report a vulnerability**.

Private vulnerability reporting must be enabled by the repository owner before
publication. If the private-reporting button is unavailable, do not open a
public issue; use the private contact method published on the
[@rsocko GitHub profile](https://github.com/rsocko).

Include the affected version or commit, impact, reproduction steps, and any
suggested remediation. Use synthetic data and remove credentials, personal
information, and private infrastructure details from the report.

The maintainers will acknowledge a report within seven calendar days, provide
status updates while it is investigated, and coordinate disclosure after a fix
is available. Do not publicly disclose an unremediated vulnerability without
coordinating with the maintainers.

## Supported versions

Mission Control is pre-1.0. Security fixes target the latest release and the
default branch. Older releases may require upgrading before a fix can be
applied. See [the compatibility policy](docs/governance/compatibility.md).

## Scope

Reports about Mission Control source, release artifacts, authentication,
authorization, connector data handling, and supported deployment templates are
in scope. Reports about third-party services should be sent to their operators
unless Mission Control caused the exposure.
