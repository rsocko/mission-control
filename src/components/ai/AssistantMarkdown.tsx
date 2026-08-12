import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const allowedElements = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
] as const;

function toDomProps<T extends { node?: unknown }>(props: T): Omit<T, 'node'> {
  const { node, ...domProps } = props;
  void node;
  return domProps;
}

function safeUrlTransform(value: string): string {
  if (value.startsWith('//')) return '';
  return defaultUrlTransform(value);
}

const components: Components = {
  a: (props) => {
    const { href, ...anchorProps } = toDomProps(props);
    if (!href) {
      return <span className="text-[var(--text-secondary)]">{anchorProps.children}</span>;
    }
    const opensNewWindow = /^https?:\/\//i.test(href);
    return (
      <a
        {...anchorProps}
        href={href}
        className="font-medium text-blue-400 underline decoration-blue-400/50 underline-offset-2 break-words hover:text-blue-300"
        rel={opensNewWindow ? 'nofollow noopener noreferrer' : undefined}
        target={opensNewWindow ? '_blank' : undefined}
      />
    );
  },
  blockquote: (props) => (
    <blockquote
      {...toDomProps(props)}
      className="my-3 border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-secondary)]"
    />
  ),
  code: (props) => (
    <code
      {...toDomProps(props)}
      className="rounded bg-[var(--surface-1)] px-1 py-0.5 font-mono text-[0.85em] text-[var(--text-primary)]"
    />
  ),
  h1: (props) => <h1 {...toDomProps(props)} className="mb-2 mt-4 text-lg font-semibold first:mt-0" />,
  h2: (props) => <h2 {...toDomProps(props)} className="mb-2 mt-4 text-base font-semibold first:mt-0" />,
  h3: (props) => <h3 {...toDomProps(props)} className="mb-1.5 mt-3 text-sm font-semibold first:mt-0" />,
  h4: (props) => <h4 {...toDomProps(props)} className="mb-1.5 mt-3 text-sm font-medium first:mt-0" />,
  h5: (props) => <h5 {...toDomProps(props)} className="mb-1 mt-2 text-sm font-medium first:mt-0" />,
  h6: (props) => (
    <h6 {...toDomProps(props)} className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] first:mt-0" />
  ),
  hr: (props) => <hr {...toDomProps(props)} className="my-4 border-[var(--border-strong)]" />,
  img: (props) => {
    const { alt } = toDomProps(props);
    return (
    // Model-provided images are rendered inert to prevent tracking requests.
      alt
      ? <span className="italic text-[var(--text-secondary)]">[Image: {alt}]</span>
      : null
    );
  },
  input: (props) => (
    <input {...toDomProps(props)} disabled className="mr-1.5 accent-blue-500" />
  ),
  li: (props) => <li {...toDomProps(props)} className="my-1 pl-0.5" />,
  ol: (props) => <ol {...toDomProps(props)} className="my-2 list-decimal space-y-1 pl-5" />,
  p: (props) => <p {...toDomProps(props)} className="my-2 leading-relaxed first:mt-0 last:mb-0" />,
  pre: (props) => (
    <pre
      {...toDomProps(props)}
      className="my-3 max-w-full overflow-x-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0"
      tabIndex={0}
    />
  ),
  table: (props) => (
    <div
      className="my-3 max-w-full overflow-x-auto rounded-md border border-[var(--border-subtle)]"
      tabIndex={0}
    >
      <table {...toDomProps(props)} className="w-full min-w-max border-collapse text-left text-xs" />
    </div>
  ),
  td: (props) => (
    <td {...toDomProps(props)} className="border-t border-[var(--border-subtle)] px-3 py-2 align-top" />
  ),
  th: (props) => (
    <th {...toDomProps(props)} className="bg-[var(--surface-1)] px-3 py-2 font-semibold text-[var(--text-secondary)]" />
  ),
  ul: (props) => <ul {...toDomProps(props)} className="my-2 list-disc space-y-1 pl-5" />,
};

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 max-w-full break-words text-sm text-[var(--text-primary)]">
      <ReactMarkdown
        allowedElements={allowedElements}
        components={components}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
