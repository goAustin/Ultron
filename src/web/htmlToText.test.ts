import { describe, expect, it } from 'vitest'
import { collapseWhitespace, decodeEntities, htmlToText } from './htmlToText.js'

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry')
    expect(decodeEntities('&lt;script&gt;')).toBe('<script>')
    expect(decodeEntities('&quot;hi&quot;')).toBe('"hi"')
    expect(decodeEntities('he&apos;s')).toBe("he's")
    expect(decodeEntities('a&nbsp;b')).toBe('a b')
  })

  it('decodes numeric refs', () => {
    expect(decodeEntities('&#39;')).toBe("'")
    expect(decodeEntities('&#x27;')).toBe("'")
    expect(decodeEntities('&#x2014;')).toBe('\u2014')
  })

  it('passes through unknown named entities', () => {
    expect(decodeEntities('&unknown;')).toBe('&unknown;')
  })

  it('passes through invalid numeric refs', () => {
    expect(decodeEntities('&#9999999;')).toBe('&#9999999;')
    expect(decodeEntities('&#xZZ;')).toBe('&#xZZ;')
  })

  it('is case-insensitive on entity names', () => {
    expect(decodeEntities('&AMP;')).toBe('&')
    expect(decodeEntities('&Quot;')).toBe('"')
  })
})

describe('collapseWhitespace', () => {
  it('collapses runs of spaces', () => {
    expect(collapseWhitespace('a    b')).toBe('a b')
  })

  it('collapses runs of newlines to at most two', () => {
    expect(collapseWhitespace('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('strips spaces around newlines', () => {
    expect(collapseWhitespace('a   \n   b')).toBe('a\nb')
  })
})

describe('htmlToText', () => {
  it('drops scripts entirely', () => {
    expect(htmlToText('<p>before</p><script>alert(1)</script><p>after</p>'))
      .toBe('before\n\nafter')
  })

  it('drops styles entirely', () => {
    expect(htmlToText('<style>body { color: red }</style><p>hi</p>'))
      .toBe('hi')
  })

  it('drops noscript entirely', () => {
    expect(htmlToText('<noscript>js disabled</noscript><p>hi</p>'))
      .toBe('hi')
  })

  it('drops HTML comments', () => {
    expect(htmlToText('<!-- secret --><p>x</p>')).toBe('x')
  })

  it('treats br/p as newlines', () => {
    expect(htmlToText('a<br>b<br/>c')).toBe('a\nb\nc')
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo')
  })

  it('strips remaining tags', () => {
    expect(htmlToText('<div><b>foo</b> <i>bar</i></div>')).toBe('foo bar')
  })

  it('decodes entities after tag strip', () => {
    expect(htmlToText('Tom &amp; Jerry')).toBe('Tom & Jerry')
    // &lt;script&gt; in body text must NOT become a real script match.
    expect(htmlToText('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'))
      .toBe('<script>alert(1)</script>')
  })

  it('collapses excessive whitespace', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb')
  })

  it('passes plain text through unchanged', () => {
    expect(htmlToText('plain text')).toBe('plain text')
  })

  it('handles empty string', () => {
    expect(htmlToText('')).toBe('')
  })

  it('handles nested tags (inline tags do not introduce whitespace)', () => {
    expect(htmlToText('<div><p>foo<b>bar</b><i>baz</i></p></div>'))
      .toBe('foobarbaz')
  })

  it('block tags inside inline content still introduce newlines', () => {
    expect(htmlToText('<div>a<p>b</p>c</div>')).toBe('a\nb\nc')
  })
})
