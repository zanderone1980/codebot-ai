import { Tool } from '../types';

export class ThinkTool implements Tool {
  name = 'think';
  description = 'A reasoning scratchpad. Use to plan your approach, analyze code, or work through complex problems before taking action. No side effects.';
  permission: Tool['permission'] = 'auto';
  parameters = {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'Your reasoning, analysis, or plan' },
    },
    required: ['thought'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    return 'Thought recorded.';
  }
}
