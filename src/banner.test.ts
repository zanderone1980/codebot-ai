import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  BANNER_1,
  BANNER_2,
  BANNER_3,
  MASCOT_1,
  MASCOT_2,
  MASCOT_3,
  banner,
  randomGreeting,
  compactBanner,
  randomBanner,
  formatReaction,
  codiReact,
  sessionSummaryBanner,
  CODI_FACE,
  animateReveal,
  animateVisorScan,
  animateEyeBoot,
  animateBootSequence,
  animateTyping,
  animateSessionEnd,
  shouldAnimate,
} from './banner';
import type { CodiMood, AnimationSpeed, AnimationWriter } from './banner';

// ── Mascot ASCII Art ──

describe('Mascot ASCII art — enterprise designs', () => {
  it('MASCOT_1 (Core) contains block-character elements', () => {
    assert.ok(MASCOT_1.includes('▄██████████████████▄'));
    assert.ok(MASCOT_1.includes('▄██▄'));
    assert.ok(MASCOT_1.includes('▀██████▀'));
  });

  it('MASCOT_2 (Terminal) contains double-line border elements', () => {
    assert.ok(MASCOT_2.includes('●'));
    assert.ok(MASCOT_2.includes('╔══════════════════════╗'));
    assert.ok(MASCOT_2.includes('╰────────╯'));
  });

  it('MASCOT_3 (Sentinel) contains visor elements', () => {
    assert.ok(MASCOT_3.includes('░░▒▓██████▓▒░░'));
    assert.ok(MASCOT_3.includes('▄████████████▄'));
    assert.ok(MASCOT_3.includes('▀████████████▀'));
  });
});

// ── Banner Functions ──

describe('Banner functions', () => {
  it('BANNER_1 includes version, model, provider, session', () => {
    const output = BANNER_1('2.1.0', 'gpt-4o', 'openai', 'abc12345', false);
    assert.ok(output.includes('2.1.0'));
    assert.ok(output.includes('gpt-4o'));
    assert.ok(output.includes('openai'));
    assert.ok(output.includes('abc12345'));
    assert.ok(output.includes('CodeBot AI'));
    assert.ok(output.includes('Think local. Code global.'));
  });

  it('BANNER_1 shows AUTONOMOUS indicator when enabled', () => {
    const auto = BANNER_1('2.1.0', 'model', 'provider', 'sess', true);
    assert.ok(auto.includes('AUTONOMOUS'));

    const manual = BANNER_1('2.1.0', 'model', 'provider', 'sess', false);
    assert.ok(!manual.includes('AUTONOMOUS'));
  });

  it('BANNER_2 includes version and model info', () => {
    const output = BANNER_2('2.1.0', 'claude-sonnet', 'anthropic', 'xyz999', false);
    assert.ok(output.includes('2.1.0'));
    assert.ok(output.includes('claude-sonnet'));
    assert.ok(output.includes('anthropic'));
  });

  it('BANNER_3 includes version and model info', () => {
    const output = BANNER_3('2.1.0', 'deepseek-chat', 'deepseek', 'sess1', true);
    assert.ok(output.includes('2.1.0'));
    assert.ok(output.includes('deepseek-chat'));
    assert.ok(output.includes('AUTONOMOUS'));
  });

  it('default banner is BANNER_1', () => {
    assert.strictEqual(banner, BANNER_1);
  });

  it('compactBanner returns single-line format', () => {
    const output = compactBanner('2.1.0', 'gpt-4o');
    assert.ok(output.includes('CodeBot AI'));
    assert.ok(output.includes('2.1.0'));
    assert.ok(output.includes('gpt-4o'));
    assert.ok(!output.includes('\n'));
  });

  it('randomBanner returns one of the three designs', () => {
    const valid = [BANNER_1, BANNER_2, BANNER_3];
    for (let i = 0; i < 20; i++) {
      const result = randomBanner();
      assert.ok(valid.includes(result), 'Should return one of the 3 banner designs');
    }
  });
});

// ── Greeting System ──

describe('Greeting system', () => {
  it('randomGreeting returns a non-empty string', () => {
    const greeting = randomGreeting();
    assert.ok(typeof greeting === 'string');
    assert.ok(greeting.length > 0);
  });

  it('randomGreeting with mood returns mood-appropriate greeting', () => {
    const resuming = randomGreeting('resuming');
    assert.ok(typeof resuming === 'string');
    assert.ok(resuming.length > 0);
  });

  it('randomGreeting with confident mood returns a greeting', () => {
    const confident = randomGreeting('confident');
    assert.ok(typeof confident === 'string');
    assert.ok(confident.length > 0);
  });

  it('randomGreeting with security mood returns a greeting', () => {
    const security = randomGreeting('security');
    assert.ok(typeof security === 'string');
    assert.ok(security.length > 0);
  });

  it('randomGreeting with unknown mood falls back to all greetings', () => {
    const unknown = randomGreeting('nonexistent');
    assert.ok(typeof unknown === 'string');
    assert.ok(unknown.length > 0);
  });

  it('randomGreeting produces variety (probabilistic)', () => {
    const results = new Set<string>();
    for (let i = 0; i < 50; i++) {
      results.add(randomGreeting());
    }
    assert.ok(results.size >= 3, `Expected variety, got ${results.size} unique greetings`);
  });
});

// ── Codi Face Expressions ──

describe('Codi face expressions', () => {
  it('has faces for all 7 moods', () => {
    const moods: CodiMood[] = ['ready', 'working', 'success', 'error', 'thinking', 'idle', 'alert'];
    for (const mood of moods) {
      assert.ok(CODI_FACE[mood], `Missing face for mood: ${mood}`);
      assert.ok(typeof CODI_FACE[mood] === 'string');
      assert.ok(CODI_FACE[mood].length > 0);
    }
  });

  it('faces contain ANSI color codes', () => {
    for (const face of Object.values(CODI_FACE)) {
      assert.ok(face.includes('\x1b['), 'Face should contain ANSI codes');
    }
  });

  it('different moods have different faces', () => {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const ready = strip(CODI_FACE.ready);
    const error = strip(CODI_FACE.error);
    const idle = strip(CODI_FACE.idle);
    assert.notStrictEqual(ready, error);
    assert.notStrictEqual(ready, idle);
    assert.notStrictEqual(error, idle);
  });
});

// ── Reactions ──

describe('Codi reactions', () => {
  it('codiReact returns face + message for tool_success', () => {
    const reaction = codiReact('tool_success');
    assert.ok(reaction.face);
    assert.ok(reaction.message);
    assert.ok(typeof reaction.face === 'string');
    assert.ok(typeof reaction.message === 'string');
  });

  it('codiReact handles tool_error with error mood', () => {
    const reaction = codiReact('tool_error');
    assert.ok(reaction.face.includes('\x1b['));
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact handles security_block', () => {
    const reaction = codiReact('security_block');
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact handles session_end', () => {
    const reaction = codiReact('session_end');
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact handles thinking', () => {
    const reaction = codiReact('thinking');
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact handles cost_warning', () => {
    const reaction = codiReact('cost_warning');
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact handles autonomous_start', () => {
    const reaction = codiReact('autonomous_start');
    assert.ok(reaction.message.length > 0);
  });

  it('codiReact falls back gracefully for unknown events', () => {
    const reaction = codiReact('totally_unknown_event');
    assert.ok(reaction.face);
    assert.ok(reaction.message);
  });

  it('formatReaction returns a formatted string', () => {
    const formatted = formatReaction('tool_success');
    assert.ok(typeof formatted === 'string');
    assert.ok(formatted.length > 10);
  });

  it('formatReaction contains ANSI color codes', () => {
    const formatted = formatReaction('tool_error');
    assert.ok(formatted.includes('\x1b['));
  });
});

// ── Session Summary Banner ──

describe('Session summary banner', () => {
  it('renders all stats correctly', () => {
    const output = sessionSummaryBanner({
      iterations: 10,
      toolCalls: 25,
      tokensUsed: 50000,
      cost: 0.1234,
      duration: 125,
    });
    assert.ok(output.includes('10'));
    assert.ok(output.includes('25'));
    assert.ok(output.includes('50,000'));
    assert.ok(output.includes('$0.1234'));
    assert.ok(output.includes('2m 5s'));
    assert.ok(output.includes('Session Complete'));
  });

  it('handles missing cost and duration gracefully', () => {
    const output = sessionSummaryBanner({
      iterations: 5,
      toolCalls: 3,
      tokensUsed: 1000,
    });
    assert.ok(output.includes('N/A'));
    assert.ok(output.includes('5'));
    assert.ok(output.includes('3'));
    assert.ok(output.includes('1,000'));
  });

  it('handles zero values', () => {
    const output = sessionSummaryBanner({
      iterations: 0,
      toolCalls: 0,
      tokensUsed: 0,
      cost: 0,
      duration: 0,
    });
    assert.ok(output.includes('$0.0000'));
    assert.ok(output.includes('0m 0s'));
  });

  it('contains visual dividers', () => {
    const output = sessionSummaryBanner({
      iterations: 1,
      toolCalls: 1,
      tokensUsed: 100,
    });
    assert.ok(output.includes('─'.repeat(50)));
  });
});

// ── Animation System ──

describe('Animation system', () => {
  // Use injectable writer to capture output without touching process.stdout
  let captured: string;
  const captureWriter: AnimationWriter = (text: string) => { captured += text; };
  const opts = { writer: captureWriter };

  it('animateReveal writes banner content', async () => {
    captured = '';
    await animateReveal(BANNER_1, '2.1.0', 'gpt-4o', 'openai', 'abc123', false, 'fast', opts);
    assert.ok(captured.includes('CodeBot AI'));
    assert.ok(captured.includes('gpt-4o'));
    assert.ok(captured.includes('▄██████████████████▄'));
  });

  it('animateReveal includes AUTONOMOUS when enabled', async () => {
    captured = '';
    await animateReveal(BANNER_3, '2.1.0', 'model', 'prov', 'sess', true, 'fast', opts);
    assert.ok(captured.includes('AUTONOMOUS'));
  });

  it('animateReveal works with all three banner designs', async () => {
    for (const b of [BANNER_1, BANNER_2, BANNER_3]) {
      captured = '';
      await animateReveal(b, '1.0.0', 'model', 'prov', 'sess', false, 'fast', opts);
      assert.ok(captured.includes('CodeBot AI'));
    }
  });

  it('animateReveal hides and shows cursor', async () => {
    captured = '';
    await animateReveal(BANNER_1, '1.0.0', 'm', 'p', 's', false, 'fast', opts);
    assert.ok(captured.includes('\x1b[?25l'), 'Should hide cursor');
    assert.ok(captured.includes('\x1b[?25h'), 'Should show cursor');
  });

  it('animateVisorScan writes sentinel visor frames', async () => {
    captured = '';
    await animateVisorScan(1, 'fast', opts);
    assert.ok(captured.includes('▄████████████▄'));
    assert.ok(captured.includes('▀████████████▀'));
    assert.ok(captured.includes('░░▒▓'));
  });

  it('animateEyeBoot writes core mascot with eye phases', async () => {
    captured = '';
    await animateEyeBoot('fast', opts);
    assert.ok(captured.includes('▄██████████████████▄'));
    assert.ok(captured.includes('▄██▄'));
    assert.ok(captured.includes('▀██▀'));
    assert.ok(captured.includes('▀██████▀'));
  });

  it('animateBootSequence writes full banner with greeting', async () => {
    captured = '';
    await animateBootSequence(BANNER_1, '2.1.0', 'gpt-4o', 'openai', 'abc123', false, 'fast', opts);
    assert.ok(captured.includes('CodeBot AI'));
    assert.ok(captured.includes('gpt-4o'));
    assert.ok(captured.includes('openai'));
  });

  it('animateBootSequence works with all designs', async () => {
    for (const b of [BANNER_1, BANNER_2, BANNER_3]) {
      captured = '';
      await animateBootSequence(b, '1.0.0', 'm', 'p', 's', false, 'fast', opts);
      assert.ok(captured.includes('CodeBot AI'));
    }
  });

  it('animateBootSequence hides and shows cursor', async () => {
    captured = '';
    await animateBootSequence(BANNER_2, '1.0.0', 'm', 'p', 's', false, 'fast', opts);
    assert.ok(captured.includes('\x1b[?25l'), 'Should hide cursor');
    assert.ok(captured.includes('\x1b[?25h'), 'Should show cursor');
  });

  it('animateTyping writes text character by character', async () => {
    captured = '';
    await animateTyping('Hello, world!', '\x1b[2m', 'fast', opts);
    assert.ok(captured.includes('Hello, world!'));
    assert.ok(captured.includes('\x1b[2m'));
    assert.ok(captured.includes('\x1b[0m'));
  });

  it('animateSessionEnd writes session summary', async () => {
    captured = '';
    await animateSessionEnd({
      iterations: 5,
      toolCalls: 10,
      tokensUsed: 25000,
      cost: 0.05,
      duration: 60,
    }, 'fast', opts);
    assert.ok(captured.includes('Session Complete'));
    assert.ok(captured.includes('25,000'));
    assert.ok(captured.includes('$0.0500'));
    assert.ok(captured.includes('1m 0s'));
  });

  it('shouldAnimate returns boolean', () => {
    const result = shouldAnimate();
    assert.ok(typeof result === 'boolean');
  });

  it('animation functions accept all speed values', async () => {
    const speeds: AnimationSpeed[] = ['fast', 'normal', 'slow'];
    for (const speed of speeds) {
      captured = '';
      await animateTyping('x', '\x1b[2m', speed, opts);
      assert.ok(captured.includes('x'), `Speed "${speed}" should produce output`);
    }
  });

  it('animateReveal handles empty model/provider gracefully', async () => {
    captured = '';
    await animateReveal(BANNER_1, '1.0.0', '', '', '', false, 'fast', opts);
    assert.ok(captured.includes('CodeBot AI'));
  });

  it('animation functions are exported as functions', () => {
    assert.strictEqual(typeof animateReveal, 'function');
    assert.strictEqual(typeof animateVisorScan, 'function');
    assert.strictEqual(typeof animateEyeBoot, 'function');
    assert.strictEqual(typeof animateBootSequence, 'function');
    assert.strictEqual(typeof animateTyping, 'function');
    assert.strictEqual(typeof animateSessionEnd, 'function');
    assert.strictEqual(typeof shouldAnimate, 'function');
  });
});
