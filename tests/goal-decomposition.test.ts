import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GoalDecomposer, SubTask, DecompositionResult } from '../src/goal-decomposition';

describe('GoalDecomposer', () => {
  const decomposer = new GoalDecomposer();

  // ── shouldDecompose ──

  describe('shouldDecompose', () => {
    it('returns false for simple messages', () => {
      assert.strictEqual(decomposer.shouldDecompose('fix the typo in README'), false);
    });

    it('returns false for short single-action messages', () => {
      assert.strictEqual(decomposer.shouldDecompose('rename the variable'), false);
    });

    it('returns false for a single sentence under 200 chars', () => {
      assert.strictEqual(decomposer.shouldDecompose('update the version number in package.json'), false);
    });

    it('returns true for messages with many action verbs and conjunctions', () => {
      const complex = 'add authentication, create user model, write tests, update the API docs, and deploy to staging';
      assert.strictEqual(decomposer.shouldDecompose(complex), true);
    });

    it('returns true for numbered list messages', () => {
      const msg = `Please do the following:
1. Create a new auth module
2. Add login endpoint
3. Write unit tests
4. Update the README`;
      assert.strictEqual(decomposer.shouldDecompose(msg), true);
    });

    it('returns true for long multi-sentence messages with multiple verbs', () => {
      const msg = 'I need you to refactor the database layer to use connection pooling. Then update all the service files to use the new pool. Also add error handling and write integration tests for the new setup. Finally deploy the changes to the staging environment.';
      assert.strictEqual(decomposer.shouldDecompose(msg), true);
    });

    it('returns true for messages mentioning multiple files with actions', () => {
      const msg = 'Fix the bug in auth.ts and update the tests in auth.test.ts, then refactor config.ts to use env vars';
      assert.strictEqual(decomposer.shouldDecompose(msg), true);
    });

    it('returns true for bullet-point lists', () => {
      const msg = `Tasks:
- Implement the caching layer
- Add Redis integration
- Write performance tests
- Deploy to staging`;
      assert.strictEqual(decomposer.shouldDecompose(msg), true);
    });
  });

  // ── decompose ──

  describe('decompose', () => {
    it('produces subtasks from a conjunction-separated message', () => {
      const msg = 'add authentication and create user model and write tests';
      const tasks = decomposer.decompose(msg);
      assert.ok(tasks.length >= 2, `Expected >= 2 tasks, got ${tasks.length}`);
      for (const task of tasks) {
        assert.ok(task.id > 0);
        assert.ok(task.description.length > 0);
        assert.strictEqual(task.status, 'pending');
      }
    });

    it('produces subtasks from a numbered list', () => {
      const msg = `1. Create auth module
2. Add login route
3. Write tests`;
      const tasks = decomposer.decompose(msg);
      assert.strictEqual(tasks.length, 3);
      assert.ok(tasks[0].description.includes('Create auth module'));
      assert.ok(tasks[1].description.includes('Add login route'));
      assert.ok(tasks[2].description.includes('Write tests'));
    });

    it('assigns sequential dependencies', () => {
      const msg = '1. Step one\n2. Step two\n3. Step three';
      const tasks = decomposer.decompose(msg);
      assert.deepStrictEqual(tasks[0].dependsOn, []);
      assert.deepStrictEqual(tasks[1].dependsOn, [1]);
      assert.deepStrictEqual(tasks[2].dependsOn, [2]);
    });

    it('estimates high complexity for refactor keywords', () => {
      const msg = '1. Refactor the database module\n2. Rename the config file';
      const tasks = decomposer.decompose(msg);
      assert.strictEqual(tasks[0].estimatedComplexity, 'high');
      assert.strictEqual(tasks[1].estimatedComplexity, 'low');
    });

    it('estimates medium complexity for fix/update keywords', () => {
      const msg = 'fix the login bug and test the auth flow';
      const tasks = decomposer.decompose(msg);
      const complexities = tasks.map(t => t.estimatedComplexity);
      assert.ok(complexities.includes('medium'));
    });

    it('returns a single task for simple messages', () => {
      const msg = 'fix the typo';
      const tasks = decomposer.decompose(msg);
      assert.strictEqual(tasks.length, 1);
      assert.deepStrictEqual(tasks[0].dependsOn, []);
    });

    it('enriches first subtask with repo context', () => {
      const msg = '1. Fix the parser\n2. Add tests';
      const tasks = decomposer.decompose(msg, 'src/parser.ts');
      assert.ok(tasks[0].description.includes('src/parser.ts'));
    });

    it('all tasks start as pending', () => {
      const msg = 'create module and add tests and deploy';
      const tasks = decomposer.decompose(msg);
      for (const task of tasks) {
        assert.strictEqual(task.status, 'pending');
      }
    });

    it('strips leading conjunctions from descriptions', () => {
      const msg = 'add auth and then write tests and also deploy';
      const tasks = decomposer.decompose(msg);
      for (const task of tasks) {
        assert.ok(!task.description.match(/^(and|then|also|finally)\s/i),
          `Task description should not start with conjunction: "${task.description}"`);
      }
    });
  });

  // ── dependency ordering ──

  describe('dependency ordering', () => {
    it('first task has no dependencies', () => {
      const msg = '1. Create module\n2. Write tests\n3. Deploy';
      const tasks = decomposer.decompose(msg);
      assert.deepStrictEqual(tasks[0].dependsOn, []);
    });

    it('each subsequent task depends on its predecessor', () => {
      const msg = '1. Create module\n2. Write tests\n3. Deploy';
      const tasks = decomposer.decompose(msg);
      for (let i = 1; i < tasks.length; i++) {
        assert.ok(tasks[i].dependsOn.includes(tasks[i - 1].id),
          `Task ${tasks[i].id} should depend on task ${tasks[i - 1].id}`);
      }
    });

    it('IDs are sequential starting from 1', () => {
      const msg = '1. A\n2. B\n3. C\n4. D';
      const tasks = decomposer.decompose(msg);
      tasks.forEach((task, idx) => {
        assert.strictEqual(task.id, idx + 1);
      });
    });
  });

  // ── buildDecompositionPrompt ──

  describe('buildDecompositionPrompt', () => {
    it('includes the user message in the prompt', () => {
      const prompt = decomposer.buildDecompositionPrompt('add dark mode');
      assert.ok(prompt.includes('add dark mode'));
    });

    it('includes repo context when provided', () => {
      const prompt = decomposer.buildDecompositionPrompt('fix the parser', 'src/parser.ts, src/lexer.ts');
      assert.ok(prompt.includes('src/parser.ts'));
      assert.ok(prompt.includes('Repository context'));
    });

    it('omits repo context section when not provided', () => {
      const prompt = decomposer.buildDecompositionPrompt('fix the parser');
      assert.ok(!prompt.includes('Repository context'));
    });

    it('mentions the SubTask schema', () => {
      const prompt = decomposer.buildDecompositionPrompt('do something');
      assert.ok(prompt.includes('SubTask'));
      assert.ok(prompt.includes('dependsOn'));
      assert.ok(prompt.includes('estimatedComplexity'));
    });

    it('asks for JSON output', () => {
      const prompt = decomposer.buildDecompositionPrompt('do something');
      assert.ok(prompt.includes('JSON'));
    });
  });

  // ── decomposeWithResult ──

  describe('decomposeWithResult', () => {
    it('returns a DecompositionResult with originalGoal', () => {
      const result = decomposer.decomposeWithResult('refactor the auth module and write tests');
      assert.strictEqual(result.originalGoal, 'refactor the auth module and write tests');
      assert.ok(result.subtasks.length >= 1);
      assert.ok(['low', 'medium', 'high'].includes(result.estimatedTotalComplexity));
    });

    it('estimates high total complexity when any subtask is high', () => {
      const result = decomposer.decomposeWithResult('refactor the DB layer and rename config');
      assert.strictEqual(result.estimatedTotalComplexity, 'high');
    });

    it('estimates low total complexity for simple tasks', () => {
      const result = decomposer.decomposeWithResult('rename the file');
      assert.strictEqual(result.estimatedTotalComplexity, 'low');
    });
  });
});
