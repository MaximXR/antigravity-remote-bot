import { htmlToTelegramHtml } from '../../src/utils/htmlToTelegramMarkdown';

describe('htmlToTelegramHtml', () => {
    describe('basic conversion', () => {
        it('returns empty string for empty input', () => {
            expect(htmlToTelegramHtml('')).toBe('');
        });

        it('returns empty string for null/undefined', () => {
            expect(htmlToTelegramHtml(null as any)).toBe('');
            expect(htmlToTelegramHtml(undefined as any)).toBe('');
        });

        it('preserves plain text', () => {
            expect(htmlToTelegramHtml('Hello world')).toBe('Hello world');
        });
    });

    describe('formatting tags', () => {
        it('converts <strong> to <b>', () => {
            expect(htmlToTelegramHtml('<strong>bold</strong>')).toBe('<b>bold</b>');
        });

        it('converts <em> to <i>', () => {
            expect(htmlToTelegramHtml('<em>italic</em>')).toBe('<i>italic</i>');
        });

        it('converts <del> to <s>', () => {
            expect(htmlToTelegramHtml('<del>deleted</del>')).toBe('<s>deleted</s>');
        });

        it('converts <strike> to <s>', () => {
            expect(htmlToTelegramHtml('<strike>struck</strike>')).toBe('<s>struck</s>');
        });

        it('converts <ins> to <u>', () => {
            expect(htmlToTelegramHtml('<ins>underline</ins>')).toBe('<u>underline</u>');
        });

        it('converts <mark> to <b>', () => {
            expect(htmlToTelegramHtml('<mark>highlighted</mark>')).toBe('<b>highlighted</b>');
        });
    });

    describe('headings', () => {
        it('converts h1 to bold', () => {
            expect(htmlToTelegramHtml('<h1>Title</h1>')).toBe('<b>Title</b>');
        });

        it('converts h3 to bold', () => {
            expect(htmlToTelegramHtml('<h3>Subtitle</h3>')).toBe('<b>Subtitle</b>');
        });

        it('strips nested tags inside headings', () => {
            expect(htmlToTelegramHtml('<h2><span>Nested</span> heading</h2>')).toBe('<b>Nested heading</b>');
        });
    });

    describe('code blocks', () => {
        it('preserves inline code tags', () => {
            expect(htmlToTelegramHtml('<code>const x = 1</code>')).toBe('<code>const x = 1</code>');
        });

        it('preserves pre/code block with language class', () => {
            const html = '<pre><code class="language-js">console.log("hi")</code></pre>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('<pre>');
            expect(result).toContain('<code>');
            expect(result).toContain('console.log("hi")');
        });

        it('preserves pre block without language', () => {
            const html = '<pre><code>plain code</code></pre>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('<pre>');
            expect(result).toContain('plain code');
        });
    });

    // Regression tests for Antigravity v1.21.6 compatibility
    // Antigravity renders markdown pipe tables as bare <pre>text</pre> blocks.
    // Two bugs combined to produce an orphan </pre> tag that caused Telegram
    // 400 "Unexpected end tag" errors.
    describe('bare <pre> blocks (Antigravity v1.21.6 regression)', () => {
        it('bare <pre> block produces matched opening and closing tags', () => {
            // Bug: <pre><code> handler skipped bare <pre>; stripUnsupportedTags
            // stripped the <pre> open but kept </pre>, causing a Telegram 400.
            const html = '<pre>| Layer | What it does |\n|---|---|\n| Bot | UI |</pre>';
            const result = htmlToTelegramHtml(html);
            const opens = (result.match(/<pre>/gi) ?? []).length;
            const closes = (result.match(/<\/pre>/gi) ?? []).length;
            expect(opens).toBe(closes);
            expect(opens).toBeGreaterThanOrEqual(1);
            expect(result).toContain('| Layer |');
        });

        it('<p> regex does not consume adjacent <pre> tags', () => {
            // Bug: <p[^>]*> matched <pre> (reads as <p + re + >) so the paragraph
            // replacement ate the <pre> opening tag, leaving an orphan </pre>.
            const html = '<p>Intro text.</p><pre>| A | B |\n| C | D |</pre><p>After text.</p>';
            const result = htmlToTelegramHtml(html);
            const opens = (result.match(/<pre>/gi) ?? []).length;
            const closes = (result.match(/<\/pre>/gi) ?? []).length;
            expect(opens).toBe(closes);
            expect(result).toContain('Intro text.');
            expect(result).toContain('| A | B |');
            expect(result).toContain('After text.');
        });

        it('multiple bare <pre> blocks all have matched tags', () => {
            // Simulates the real failing case: a table <pre> followed by a code-flow <pre>.
            const html =
                '<p>Here is a table:</p>' +
                '<pre>| Layer | What it does |\n|---|---|\n| Bot | UI |</pre>' +
                '<p>And the flow:</p>' +
                '<pre>Telegram → router\n  └── text → agent</pre>';
            const result = htmlToTelegramHtml(html);
            const opens = (result.match(/<pre>/gi) ?? []).length;
            const closes = (result.match(/<\/pre>/gi) ?? []).length;
            expect(opens).toBe(closes);
            expect(opens).toBe(2);
        });
    });

    describe('links', () => {
        it('preserves link tags with href', () => {
            const html = '<a href="https://example.com">click here</a>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('<a href="https://example.com">click here</a>');
        });

        it('strips anchor links (#)', () => {
            const html = '<a href="#section">jump</a>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('jump');
            expect(result).not.toContain('href="#section"');
        });

        it('strips javascript: links', () => {
            const html = '<a href="javascript:alert(1)">xss</a>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('xss');
            expect(result).not.toContain('javascript:');
        });
    });

    describe('line breaks and separators', () => {
        it('converts <br> to newline', () => {
            expect(htmlToTelegramHtml('a<br>b')).toContain('a\nb');
        });

        it('converts <br/> to newline', () => {
            expect(htmlToTelegramHtml('a<br/>b')).toContain('a\nb');
        });

        it('converts <hr> to separator', () => {
            expect(htmlToTelegramHtml('a<hr>b')).toContain('---');
        });
    });

    describe('blockquotes', () => {
        it('preserves blockquote tags', () => {
            const html = '<blockquote>quoted text</blockquote>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('<blockquote>quoted text</blockquote>');
        });
    });

    describe('lists', () => {
        it('converts unordered list to dashes', () => {
            const html = '<ul><li>item 1</li><li>item 2</li></ul>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('- item 1');
            expect(result).toContain('- item 2');
        });

        it('converts ordered list to numbers', () => {
            const html = '<ol><li>first</li><li>second</li></ol>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('1. first');
            expect(result).toContain('2. second');
        });

        it('preserves formatting tags inside list items', () => {
            const html = '<ul><li>item <b>bold</b></li><li>item <code>code</code></li></ul>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('- item <b>bold</b>');
            expect(result).toContain('- item <code>code</code>');
        });
    });

    describe('images', () => {
        it('shows alt text for images', () => {
            const html = '<img alt="diagram" src="img.png">';
            expect(htmlToTelegramHtml(html)).toContain('[diagram]');
        });

        it('removes images without alt text', () => {
            const html = 'before<img src="img.png">after';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('beforeafter');
        });
    });

    describe('tables', () => {
        it('converts HTML table to ASCII table with pipes', () => {
            const html = '<table><tr><th>Name</th><th>Value</th></tr><tr><td>foo</td><td>42</td></tr></table>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('Name');
            expect(result).toContain('foo');
            expect(result).toContain('|');
        });

        it('returns empty for table with no rows', () => {
            const html = '<table></table>';
            const result = htmlToTelegramHtml(html);
            expect(result).toBe('');
        });
    });

    describe('entity decoding', () => {
        it('preserves &amp; for Telegram HTML', () => {
            expect(htmlToTelegramHtml('A &amp; B')).toContain('A &amp; B');
        });

        it('preserves &lt; and &gt; for Telegram HTML', () => {
            expect(htmlToTelegramHtml('&lt;tag&gt;')).toContain('&lt;tag&gt;');
        });

        it('decodes &nbsp; to space', () => {
            expect(htmlToTelegramHtml('a&nbsp;b')).toContain('a b');
        });

        it('decodes numeric entities', () => {
            expect(htmlToTelegramHtml('&#65;')).toContain('A');
        });

        it('decodes hex entities', () => {
            expect(htmlToTelegramHtml('&#x41;')).toContain('A');
        });

        it('decodes &quot;', () => {
            expect(htmlToTelegramHtml('&quot;hello&quot;')).toContain('"hello"');
        });

        it('decodes &#39; (apostrophe)', () => {
            expect(htmlToTelegramHtml("it&#39;s")).toContain("it's");
        });
    });

    describe('tag stripping', () => {
        it('strips non-Telegram tags like <span>', () => {
            expect(htmlToTelegramHtml('<span>text</span>')).toBe('text');
        });

        it('removes <style> blocks', () => {
            const html = '<style>.cls { color: red; }</style>Hello';
            expect(htmlToTelegramHtml(html)).toBe('Hello');
        });

        it('removes <script> blocks', () => {
            const html = '<script>alert(1)</script>Hello';
            expect(htmlToTelegramHtml(html)).toBe('Hello');
        });

        it('strips <div> and <p> wrappers', () => {
            expect(htmlToTelegramHtml('<div>content</div>')).toBe('content');
            expect(htmlToTelegramHtml('<p>paragraph</p>')).toBe('paragraph');
        });
    });

    describe('details/summary', () => {
        it('shows summary as bold with content', () => {
            const html = '<details><summary>Click me</summary>Hidden content</details>';
            const result = htmlToTelegramHtml(html);
            expect(result).toContain('<b>Click me</b>');
            expect(result).toContain('Hidden content');
        });
    });

    describe('superscript/subscript', () => {
        it('converts superscript with ^ prefix', () => {
            expect(htmlToTelegramHtml('x<sup>2</sup>')).toContain('x^2');
        });

        it('converts subscript with _ prefix', () => {
            expect(htmlToTelegramHtml('H<sub>2</sub>O')).toContain('H_2O');
        });
    });
});
