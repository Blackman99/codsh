/**
 * Inline-graphics protocol detection and escape construction.
 */

import { describe, expect, it } from 'vitest'
import { graphicsProtocol, iterm2Image, kittyDelete, kittyImage } from '../src/terminal-graphics.ts'

const ESC = '\u001B'

describe('graphicsProtocol', () => {
  it('answers kitty for the terminals that implement kitty graphics', () => {
    // Ghostty implements Kitty graphics and ignores OSC 1337 File= entirely,
    // which is the whole reason this is not one flag for "supports images".
    expect(graphicsProtocol({ TERM_PROGRAM: 'ghostty' })).toBe('kitty')
    expect(graphicsProtocol({ TERM: 'xterm-ghostty' })).toBe('kitty')
    expect(graphicsProtocol({ TERM: 'xterm-kitty' })).toBe('kitty')
    expect(graphicsProtocol({ KITTY_WINDOW_ID: '1' })).toBe('kitty')
    expect(graphicsProtocol({ TERM_PROGRAM: 'WezTerm' })).toBe('kitty')
  })

  it('answers iterm2 only for iTerm2', () => {
    expect(graphicsProtocol({ TERM_PROGRAM: 'iTerm.app' })).toBe('iterm2')
    expect(graphicsProtocol({ LC_TERMINAL: 'iTerm2' })).toBe('iterm2')
  })

  it('answers nothing for a terminal with no graphics protocol', () => {
    expect(graphicsProtocol({ TERM: 'xterm-256color' })).toBeUndefined()
    expect(graphicsProtocol({})).toBeUndefined()
  })

  it('answers nothing inside a multiplexer, whatever the terminal is', () => {
    // tmux does not hand the payload through to the emulator that could paint
    // it, so a graphic sent from inside one is lost with the card left blank.
    expect(graphicsProtocol({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })).toBeUndefined()
    expect(graphicsProtocol({ TERM_PROGRAM: 'ghostty', TERM: 'screen-256color' })).toBeUndefined()
    expect(graphicsProtocol({ TERM_PROGRAM: 'iTerm.app', TERM: 'tmux-256color' })).toBeUndefined()
  })
})

describe('kittyImage', () => {
  it('transmits and places a PNG in one escape when it fits', () => {
    const out = kittyImage('QUJD', 42, 20, 10)
    expect(out).toBe(`${ESC}_Ga=T,f=100,t=d,i=42,c=20,r=10,C=1,q=2;QUJD${ESC}\\`)
  })

  it('suppresses the terminal reply and pins the cursor', () => {
    const out = kittyImage('QUJD', 1, 4, 2)
    // Without q=2 the reply arrives on stdin, which this surface reads as
    // keys; without C=1 the placement moves the cursor and can scroll.
    expect(out).toContain('q=2')
    expect(out).toContain('C=1')
  })

  it('chunks a payload past the protocol limit, keys on the first escape only', () => {
    const payload = 'A'.repeat(4096 * 2 + 8)
    const out = kittyImage(payload, 7, 30, 12)
    const escapes = out.split(`${ESC}_G`).slice(1)
    expect(escapes.length).toBe(3)
    expect(escapes[0]).toContain('a=T,f=100,t=d,i=7,c=30,r=12,C=1,q=2,m=1;')
    // Every later escape may carry nothing but m and q.
    expect(escapes[1]?.startsWith('m=1,q=2;')).toBe(true)
    expect(escapes[2]?.startsWith('m=0,q=2;')).toBe(true)
    const sent = escapes.map(escape => escape.slice(escape.indexOf(';') + 1).replace(`${ESC}\\`, '')).join('')
    expect(sent).toBe(payload)
  })
})

describe('kittyDelete', () => {
  it('deletes one image by id and frees its bytes', () => {
    expect(kittyDelete(42)).toBe(`${ESC}_Ga=d,d=I,i=42,q=2${ESC}\\`)
  })
})

describe('iterm2Image', () => {
  it('fits the image inside the cell rectangle rather than filling it', () => {
    const out = iterm2Image('QUJD', 20, 10)
    expect(out).toBe(`${ESC}]1337;File=inline=1;width=20;height=10;preserveAspectRatio=1:QUJD\u0007`)
  })
})
