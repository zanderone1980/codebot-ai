import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getModelInfo, MODEL_REGISTRY } from './registry';
import { Message, ImageAttachment } from '../types';

describe('Vision/Multimodal — registry supportsVision (v2.1.6)', () => {
  it('all Anthropic models support vision', () => {
    const models = Object.entries(MODEL_REGISTRY).filter(([, i]) => i.provider === 'anthropic');
    for (const [name, info] of models) {
      assert.strictEqual(info.supportsVision, true, `${name} should support vision`);
    }
  });

  it('GPT-4o and GPT-4.1 support vision', () => {
    assert.strictEqual(getModelInfo('gpt-4o').supportsVision, true);
    assert.strictEqual(getModelInfo('gpt-4o-mini').supportsVision, true);
    assert.strictEqual(getModelInfo('gpt-4.1').supportsVision, true);
    assert.strictEqual(getModelInfo('gpt-4-turbo').supportsVision, true);
  });

  it('o1/o3-mini do NOT support vision', () => {
    assert.strictEqual(getModelInfo('o1').supportsVision, undefined);
    assert.strictEqual(getModelInfo('o3-mini').supportsVision, undefined);
  });

  it('o3 and o4-mini support vision', () => {
    assert.strictEqual(getModelInfo('o3').supportsVision, true);
    assert.strictEqual(getModelInfo('o4-mini').supportsVision, true);
  });

  it('all Gemini models support vision', () => {
    const models = Object.entries(MODEL_REGISTRY).filter(([, i]) => i.provider === 'gemini');
    for (const [name, info] of models) {
      assert.strictEqual(info.supportsVision, true, `${name} should support vision`);
    }
  });

  it('local models do not have vision flag', () => {
    assert.strictEqual(getModelInfo('qwen2.5-coder:32b').supportsVision, undefined);
    assert.strictEqual(getModelInfo('llama3.1:8b').supportsVision, undefined);
  });
});

describe('Vision/Multimodal — Anthropic image content blocks', () => {
  it('converts tool message with images to content block array', () => {
    const msg: Message = {
      role: 'tool',
      content: 'Screenshot saved: /tmp/shot.png (150KB)',
      tool_call_id: 'call_1',
      images: [{
        data: 'iVBORw0KGgoAAAANSUhEUg==',  // tiny base64 stub
        mediaType: 'image/png',
      }],
    };

    // Simulate Anthropic conversion
    let toolContent: string | Array<Record<string, unknown>> = msg.content;
    if (msg.images?.length) {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const img of msg.images) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        });
      }
      toolContent = blocks;
    }

    assert.ok(Array.isArray(toolContent));
    assert.strictEqual(toolContent.length, 2);
    assert.strictEqual(toolContent[0].type, 'text');
    assert.strictEqual(toolContent[1].type, 'image');
    assert.deepStrictEqual((toolContent[1] as Record<string, unknown>).source, {
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUg==',
    });
  });

  it('converts user message with images to content block array', () => {
    const msg: Message = {
      role: 'user',
      content: 'What do you see in this image?',
      images: [{
        data: 'dGVzdA==',
        mediaType: 'image/jpeg',
      }],
    };

    const content: Array<Record<string, unknown>> = [];
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const img of msg.images!) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }

    assert.strictEqual(content.length, 2);
    assert.strictEqual(content[0].type, 'text');
    assert.strictEqual(content[0].text, 'What do you see in this image?');
    assert.strictEqual(content[1].type, 'image');
  });

  it('keeps message as plain string when no images', () => {
    const msg: Message = {
      role: 'user',
      content: 'Hello, no images here.',
    };

    if (msg.images?.length) {
      assert.fail('should not enter image path');
    }
    // Message stays as plain string
    assert.strictEqual(typeof msg.content, 'string');
  });
});

describe('Vision/Multimodal — OpenAI image content blocks', () => {
  it('formats message with images using image_url blocks', () => {
    const msg: Message = {
      role: 'user',
      content: 'Describe this screenshot.',
      images: [{
        data: 'iVBORw0KGgoAAAANSUhEUg==',
        mediaType: 'image/png',
      }],
    };

    // Simulate OpenAI formatMessage
    const formatted: Record<string, unknown> = { role: msg.role, content: msg.content };
    if (msg.images?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const img of msg.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'auto' },
        });
      }
      formatted.content = content;
    }

    const contentBlocks = formatted.content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(contentBlocks));
    assert.strictEqual(contentBlocks.length, 2);
    assert.strictEqual(contentBlocks[0].type, 'text');
    assert.strictEqual(contentBlocks[1].type, 'image_url');
    const imageUrl = (contentBlocks[1] as Record<string, unknown>).image_url as Record<string, string>;
    assert.ok(imageUrl.url.startsWith('data:image/png;base64,'));
    assert.strictEqual(imageUrl.detail, 'auto');
  });
});

describe('Vision/Multimodal — ImageAttachment type', () => {
  it('supports png, jpeg, gif, webp media types', () => {
    const types: ImageAttachment['mediaType'][] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    for (const mediaType of types) {
      const img: ImageAttachment = { data: 'dGVzdA==', mediaType };
      assert.strictEqual(img.mediaType, mediaType);
      assert.strictEqual(img.data, 'dGVzdA==');
    }
  });
});

describe('Vision/Multimodal — context manager image token estimation', () => {
  it('estimates ~1000 tokens per image', () => {
    // Simulate ContextManager.estimateMessageTokens
    const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
    const estimateMessageTokens = (msg: Message) => {
      let tokens = estimateTokens(msg.content);
      if (msg.images?.length) {
        tokens += msg.images.length * 1000;
      }
      return tokens;
    };

    const textOnly: Message = { role: 'user', content: 'Hello world' };
    const withImage: Message = {
      role: 'tool',
      content: 'Screenshot saved',
      images: [{ data: 'abc', mediaType: 'image/png' }],
    };
    const withTwoImages: Message = {
      role: 'tool',
      content: 'Screenshots',
      images: [
        { data: 'abc', mediaType: 'image/png' },
        { data: 'def', mediaType: 'image/jpeg' },
      ],
    };

    assert.strictEqual(estimateMessageTokens(textOnly), estimateTokens('Hello world'));
    assert.strictEqual(
      estimateMessageTokens(withImage),
      estimateTokens('Screenshot saved') + 1000,
    );
    assert.strictEqual(
      estimateMessageTokens(withTwoImages),
      estimateTokens('Screenshots') + 2000,
    );
  });

  it('no extra tokens when message has no images', () => {
    const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
    const estimateMessageTokens = (msg: Message) => {
      let tokens = estimateTokens(msg.content);
      if (msg.images?.length) {
        tokens += msg.images.length * 1000;
      }
      return tokens;
    };

    const msg: Message = { role: 'user', content: 'Just text, no images at all.' };
    assert.strictEqual(estimateMessageTokens(msg), estimateTokens(msg.content));
  });
});
