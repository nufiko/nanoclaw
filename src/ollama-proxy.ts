/**
 * Anthropic Messages API → Ollama proxy.
 * The Claude Agent SDK sends Anthropic-format requests; this proxy translates
 * them to Ollama's /api/chat format and streams Anthropic SSE back.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';

import { logger } from './logger.js';

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  temperature?: number;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

function contentToText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

function toOllamaMessages(
  msgs: AnthropicMessage[],
  system?: string,
): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: 'system', content: system });

  for (const msg of msgs) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }

    const toolResults = msg.content.filter((b) => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const text =
          typeof tr.content === 'string'
            ? tr.content
            : Array.isArray(tr.content)
              ? (tr.content as AnthropicContentBlock[])
                  .map((c) => c.text ?? '')
                  .join('')
              : '';
        out.push({ role: 'tool', content: text });
      }
      continue;
    }

    const toolUses = msg.content.filter((b) => b.type === 'tool_use');
    const text = contentToText(msg.content);
    if (toolUses.length > 0) {
      out.push({
        role: msg.role,
        content: text,
        tool_calls: toolUses.map((t) => ({
          function: {
            name: t.name ?? '',
            arguments: JSON.stringify(t.input ?? {}),
          },
        })),
      });
    } else {
      out.push({ role: msg.role, content: text });
    }
  }

  return out;
}

function toOllamaTools(tools: AnthropicTool[]) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema,
    },
  }));
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  model: string,
  ollamaBase: string,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let body: AnthropicRequest;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;
  } catch {
    res.writeHead(400);
    res.end('Bad JSON');
    return;
  }

  const ollamaBody: Record<string, unknown> = {
    model,
    messages: toOllamaMessages(body.messages, body.system),
    stream: body.stream !== false,
    options: {
      num_predict: body.max_tokens ?? 8096,
      temperature: body.temperature ?? 0.7,
    },
  };
  if (body.tools?.length) {
    ollamaBody.tools = toOllamaTools(body.tools);
  }

  const ollamaRes = await fetch(`${ollamaBase}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ollamaBody),
  });

  if (!ollamaRes.ok || !ollamaRes.body) {
    const err = await ollamaRes.text().catch(() => '');
    logger.error({ status: ollamaRes.status, err }, 'Ollama request failed');
    res.writeHead(502);
    res.end('Ollama error');
    return;
  }

  const msgId = `msg_${Date.now()}`;

  if (body.stream !== false) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    res.write(
      sse('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
    res.write(
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    res.write(sse('ping', { type: 'ping' }));

    let outputTokens = 0;
    let pendingToolCalls: { function: { name: string; arguments: string } }[] =
      [];
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.trim()) continue;
        let chunk: { message?: OllamaMessage; done?: boolean };
        try {
          chunk = JSON.parse(line) as { message?: OllamaMessage; done?: boolean };
        } catch {
          continue;
        }
        if (chunk.message?.content) {
          outputTokens++;
          res.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: chunk.message.content },
            }),
          );
        }
        if (chunk.message?.tool_calls?.length) {
          pendingToolCalls = chunk.message.tool_calls;
        }
      }
    }

    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));

    if (pendingToolCalls.length > 0) {
      for (let i = 0; i < pendingToolCalls.length; i++) {
        const tc = pendingToolCalls[i];
        const idx = i + 1;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          /* keep empty */
        }
        res.write(
          sse('content_block_start', {
            type: 'content_block_start',
            index: idx,
            content_block: {
              type: 'tool_use',
              id: `toolu_${Date.now()}_${i}`,
              name: tc.function.name,
              input: {},
            },
          }),
        );
        res.write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
          }),
        );
        res.write(
          sse('content_block_stop', { type: 'content_block_stop', index: idx }),
        );
      }
    }

    const stopReason = pendingToolCalls.length > 0 ? 'tool_use' : 'end_turn';
    res.write(
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
    );
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  } else {
    const data = (await ollamaRes.json()) as { message?: OllamaMessage };
    const text = data.message?.content ?? '';
    const tcs = data.message?.tool_calls ?? [];
    const content: unknown[] = [];
    if (text) content.push({ type: 'text', text });
    for (let i = 0; i < tcs.length; i++) {
      const tc = tcs[i];
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        /* keep empty */
      }
      content.push({
        type: 'tool_use',
        id: `toolu_${Date.now()}_${i}`,
        name: tc.function.name,
        input: args,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: msgId,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: tcs.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
  }
}

export function startOllamaProxy(
  model: string,
  ollamaBase: string,
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        handleMessages(req, res, model, ollamaBase).catch((err) => {
          logger.error({ err }, 'Ollama proxy error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Proxy error');
          }
        });
      } else {
        // Stub /v1/models so the SDK doesn't complain
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: model }] }));
      }
    });

    server.listen(port, host, () => {
      logger.info({ port, host, model, ollamaBase }, 'Ollama proxy started');
      resolve(server);
    });
    server.on('error', reject);
  });
}
