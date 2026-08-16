import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  EmbeddedMarkdownImage,
  MarkdownSourceUrlContext,
  TaskDetailMarkdown,
  remarkOnlyEmbeddedImages,
  toggleMarkdownCheckbox,
} from '@/components/task-detail/TaskDetailMarkdown';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

function transform(tree: MarkdownNode) {
  remarkOnlyEmbeddedImages()(tree);
  return tree;
}

describe('remarkOnlyEmbeddedImages', () => {
  it('keeps standalone image tags as HTML', () => {
    const tree = transform({
      type: 'root',
      children: [{ type: 'html', value: '<img src="https://example.com/a.png" alt="a" />' }],
    });

    expect(tree.children?.[0].type).toBe('html');
  });

  it('downgrades other raw HTML to text', () => {
    const tree = transform({
      type: 'root',
      children: [
        { type: 'html', value: '<script>alert(1)</script>' },
        { type: 'html', value: '<iframe src="https://evil.example"></iframe>' },
        { type: 'html', value: '<img src="x" onerror="alert(1)"><script>steal()</script>' },
      ],
    });

    expect(tree.children?.map((child) => child.type)).toEqual(['text', 'text', 'text']);
  });

  it('walks nested children', () => {
    const tree = transform({
      type: 'root',
      children: [{
        type: 'paragraph',
        children: [{ type: 'html', value: '<b>bold</b>' }],
      }],
    });

    expect(tree.children?.[0].children?.[0].type).toBe('text');
  });
});

describe('toggleMarkdownCheckbox', () => {
  const markdown = [
    '- [ ] first',
    '- [x] second',
    '  - [ ] nested third',
    'not a checkbox',
  ].join('\n');

  it('checks only the requested checkbox', () => {
    expect(toggleMarkdownCheckbox(markdown, 0, true)).toBe([
      '- [x] first',
      '- [x] second',
      '  - [ ] nested third',
      'not a checkbox',
    ].join('\n'));
  });

  it('unchecks the requested checkbox', () => {
    expect(toggleMarkdownCheckbox(markdown, 1, false)).toContain('- [ ] second');
  });

  it('counts nested checkboxes in render order', () => {
    expect(toggleMarkdownCheckbox(markdown, 2, true)).toContain('  - [x] nested third');
  });

  it('leaves the markdown untouched for an unknown index', () => {
    expect(toggleMarkdownCheckbox(markdown, 9, true)).toBe(markdown);
  });
});

describe('EmbeddedMarkdownImage', () => {
  it('renders the image until it fails', () => {
    render(<EmbeddedMarkdownImage src="https://example.com/a.png" alt="Diagram" />);
    const image = screen.getByAltText('Diagram');

    expect(image).toBeInTheDocument();
    fireEvent.error(image);

    expect(screen.getByText('Image unavailable')).toBeInTheDocument();
    expect(screen.getByText('Diagram could not be loaded.')).toBeInTheDocument();
  });

  it('calls through to a caller supplied error handler', () => {
    const onError = vi.fn();
    render(<EmbeddedMarkdownImage src="https://example.com/a.png" alt="Diagram" onError={onError} />);

    fireEvent.error(screen.getByAltText('Diagram'));

    expect(onError).toHaveBeenCalledOnce();
  });

  it('explains private GitHub attachments and links to the source task', () => {
    render(
      <MarkdownSourceUrlContext.Provider value="https://github.com/acme/repo/issues/7">
        <EmbeddedMarkdownImage src="https://github.com/user-attachments/assets/abc" alt="Screenshot" />
      </MarkdownSourceUrlContext.Provider>,
    );

    fireEvent.error(screen.getByAltText('Screenshot'));

    expect(screen.getByText('Private GitHub attachment could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open task in GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/repo/issues/7',
    );
  });

  it('omits the source link when no source URL is available', () => {
    render(<EmbeddedMarkdownImage src="https://example.com/a.png" alt="Diagram" />);
    fireEvent.error(screen.getByAltText('Diagram'));

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('TaskDetailMarkdown', () => {
  it('syntax highlights fenced code blocks using their declared language', async () => {
    render(
      <TaskDetailMarkdown>
        {'```yaml\nruns-on: [self-hosted, macOS, ARM64, ios]\n```'}
      </TaskDetailMarkdown>,
    );

    const attribute = await screen.findByText('runs-on:');
    const code = attribute.closest('code');
    expect(code).not.toBeNull();
    expect(code!).toHaveClass('language-yaml', 'hljs');
    expect(code!.querySelector('.hljs-attr')).toHaveTextContent('runs-on:');
  });

  it('renders GitHub flavored markdown and marks external links safe', async () => {
    render(
      <TaskDetailMarkdown sourceUrl={null}>
        {'# Heading\n\n[external](https://example.com) and [internal](/tasks/1)'}
      </TaskDetailMarkdown>,
    );

    const external = await screen.findByRole('link', { name: 'external' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');

    const internal = screen.getByRole('link', { name: 'internal' });
    expect(internal).not.toHaveAttribute('target');
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  });

  it('strips scripts while keeping embedded images', async () => {
    render(
      <TaskDetailMarkdown sourceUrl={null}>
        {'<script>alert(1)</script>\n\n<img src="https://example.com/a.png" alt="Embedded" />'}
      </TaskDetailMarkdown>,
    );

    expect(await screen.findByAltText('Embedded')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/alert\(1\)/)).toBeInTheDocument();
  });

  it('reports checkbox toggles by rendered index', async () => {
    const onCheckboxToggle = vi.fn();
    render(
      <TaskDetailMarkdown onCheckboxToggle={onCheckboxToggle}>
        {'- [ ] first\n- [ ] second'}
      </TaskDetailMarkdown>,
    );

    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    expect(onCheckboxToggle).toHaveBeenCalledWith(1, true);
  });
});
