/**
 * Skill Evolution Engine
 *
 * Skills test themselves, measure success rates, retire low-confidence,
 * generate variants for top performers, and compose complementary skills
 * into higher-order skills.
 *
 * Evolution cycle: test → retire → evolve → compose
 * Runs on scheduler (weekly) or daemon trigger.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';
import { SkillDefinition, loadSkills } from './skills';

// ── Types ──

export interface SkillTestResult {
  skillName: string;
  passed: boolean;
  message: string;
  durationMs: number;
  testedAt: string;
}

export interface EvolutionReport {
  tested: SkillTestResult[];
  retired: string[];
  evolved: string[];
  composed: string[];
  timestamp: string;
}

// ── Skill Evolution Engine ──

export class SkillEvolution {
  /** Confidence below this → retire */
  private retireThreshold = 0.1;
  /** Confidence above this → candidate for evolution */
  private evolveThreshold = 0.7;
  /** Minimum use_count to consider for evolution */
  private minUsesForEvolution = 3;

  /**
   * Run a full evolution cycle.
   * Returns a report of what happened.
   */
  async evolve(
    testRunner?: (skill: SkillDefinition) => Promise<{ passed: boolean; message: string }>,
  ): Promise<EvolutionReport> {
    const skills = loadSkills();
    const now = new Date().toISOString();

    const report: EvolutionReport = {
      tested: [],
      retired: [],
      evolved: [],
      composed: [],
      timestamp: now,
    };

    // Phase 1: Test all skills
    for (const skill of skills) {
      const result = await this.testSkill(skill, testRunner);
      report.tested.push(result);

      // Update confidence based on test result
      this.reinforceSkill(skill, result.passed);
    }

    // Phase 2: Retire failures
    const retired = this.retireFailures(skills);
    report.retired = retired;

    // Phase 3: Generate variants for top performers
    const evolved = this.generateVariants(skills);
    report.evolved = evolved;

    // Phase 4: Compose complementary skills
    const composed = this.composeSkills(skills);
    report.composed = composed;

    // Persist the report
    this.persistReport(report);

    return report;
  }

  /**
   * Test a single skill by validating its steps are well-formed.
   * If a testRunner is provided, actually execute the skill.
   */
  async testSkill(
    skill: SkillDefinition,
    testRunner?: (skill: SkillDefinition) => Promise<{ passed: boolean; message: string }>,
  ): Promise<SkillTestResult> {
    const start = Date.now();

    // Basic structural validation
    if (!skill.steps || skill.steps.length === 0) {
      return {
        skillName: skill.name,
        passed: false,
        message: 'Skill has no steps',
        durationMs: Date.now() - start,
        testedAt: new Date().toISOString(),
      };
    }

    for (const step of skill.steps) {
      if (!step.tool || typeof step.tool !== 'string') {
        return {
          skillName: skill.name,
          passed: false,
          message: `Step has invalid tool: ${JSON.stringify(step)}`,
          durationMs: Date.now() - start,
          testedAt: new Date().toISOString(),
        };
      }
    }

    // If test runner provided, do a real test
    if (testRunner) {
      try {
        const result = await testRunner(skill);
        return {
          skillName: skill.name,
          passed: result.passed,
          message: result.message,
          durationMs: Date.now() - start,
          testedAt: new Date().toISOString(),
        };
      } catch (err: unknown) {
        return {
          skillName: skill.name,
          passed: false,
          message: `Test error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: Date.now() - start,
          testedAt: new Date().toISOString(),
        };
      }
    }

    return {
      skillName: skill.name,
      passed: true,
      message: 'Structural validation passed',
      durationMs: Date.now() - start,
      testedAt: new Date().toISOString(),
    };
  }

  /**
   * Retire skills with confidence below threshold.
   * Moves them to ~/.codebot/skills/retired/ instead of deleting.
   */
  retireFailures(skills: SkillDefinition[]): string[] {
    const retired: string[] = [];
    const skillsDir = codebotPath('skills');
    const retiredDir = codebotPath('skills/retired');

    for (const skill of skills) {
      if ((skill.confidence ?? 0.5) < this.retireThreshold) {
        try {
          fs.mkdirSync(retiredDir, { recursive: true });
          const srcPath = path.join(skillsDir, `${skill.name}.json`);
          const destPath = path.join(retiredDir, `${skill.name}.json`);

          if (fs.existsSync(srcPath)) {
            // Mark as retired before moving
            const data = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
            data.retired = true;
            data.retired_at = new Date().toISOString();
            fs.writeFileSync(destPath, JSON.stringify(data, null, 2));
            fs.unlinkSync(srcPath);
            retired.push(skill.name);
          }
        } catch { /* skip on error */ }
      }
    }

    return retired;
  }

  /**
   * Generate variants of top-performing skills.
   * A variant is the same skill with a minor tweak (e.g., different tool order).
   */
  generateVariants(skills: SkillDefinition[]): string[] {
    const created: string[] = [];
    const skillsDir = codebotPath('skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    for (const skill of skills) {
      const confidence = skill.confidence ?? 0.5;
      const useCount = skill.use_count ?? 0;

      if (confidence < this.evolveThreshold || useCount < this.minUsesForEvolution) continue;

      // Generate a variant with reversed non-dependent steps
      const variantName = `${skill.name}_v${Date.now().toString(36).slice(-4)}`;
      const variantPath = path.join(skillsDir, `${variantName}.json`);

      // Don't create if variant already exists
      if (fs.existsSync(variantPath)) continue;

      // Simple variant: add a "think" step before the main steps
      const variant: SkillDefinition = {
        name: variantName,
        description: `[Evolved] ${skill.description}`,
        steps: [
          { tool: 'think', args: { thought: `Planning execution of evolved skill: ${skill.name}` } },
          ...skill.steps,
        ],
        author: skill.author || 'codebot',
        confidence: confidence * 0.8, // Start lower than parent
        use_count: 0,
        origin: 'evolved',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (skill.trigger) variant.trigger = skill.trigger;

      try {
        fs.writeFileSync(variantPath, JSON.stringify(variant, null, 2));
        created.push(variantName);
      } catch { /* skip */ }
    }

    return created;
  }

  /**
   * Compose complementary skills into higher-order skills.
   * Looks for skill pairs that cover different tools and combines them.
   */
  composeSkills(skills: SkillDefinition[]): string[] {
    const composed: string[] = [];
    const skillsDir = codebotPath('skills');
    fs.mkdirSync(skillsDir, { recursive: true });

    // Only compose high-confidence skills
    const candidates = skills.filter(s => (s.confidence ?? 0.5) >= this.evolveThreshold);

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];

        // Check if they're complementary (different tool sets)
        const toolsA = new Set(a.steps.map(s => s.tool));
        const toolsB = new Set(b.steps.map(s => s.tool));
        const overlap = [...toolsA].filter(t => toolsB.has(t));

        // Only compose if < 50% overlap and each has unique tools
        if (overlap.length / Math.max(toolsA.size, toolsB.size) >= 0.5) continue;

        const composedName = `composed_${a.name}_${b.name}`.substring(0, 64);
        const composedPath = path.join(skillsDir, `${composedName}.json`);

        // Don't re-compose
        if (fs.existsSync(composedPath)) continue;

        const combined: SkillDefinition = {
          name: composedName,
          description: `[Composed] ${a.description} + ${b.description}`,
          steps: [...a.steps, ...b.steps],
          author: 'codebot',
          confidence: Math.min(a.confidence ?? 0.5, b.confidence ?? 0.5) * 0.7,
          use_count: 0,
          origin: 'composed',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        try {
          fs.writeFileSync(composedPath, JSON.stringify(combined, null, 2));
          composed.push(composedName);
        } catch { /* skip */ }

        // Limit compositions per cycle
        if (composed.length >= 3) return composed;
      }
    }

    return composed;
  }

  /**
   * Update a skill's confidence based on test result.
   */
  private reinforceSkill(skill: SkillDefinition, success: boolean): void {
    const skillPath = path.join(codebotPath('skills'), `${skill.name}.json`);
    if (!fs.existsSync(skillPath)) return;

    try {
      const data = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
      const current = data.confidence ?? 0.5;
      data.confidence = success
        ? Math.min(current + 0.05, 1.0)
        : Math.max(current - 0.1, 0.0);
      data.updated_at = new Date().toISOString();
      fs.writeFileSync(skillPath, JSON.stringify(data, null, 2));
    } catch { /* skip */ }
  }

  /**
   * Format an evolution report for display.
   */
  static formatReport(report: EvolutionReport): string {
    const lines = [
      'Skill Evolution Report',
      `  Tested: ${report.tested.length} (${report.tested.filter(t => t.passed).length} passed)`,
      `  Retired: ${report.retired.length}${report.retired.length > 0 ? ` (${report.retired.join(', ')})` : ''}`,
      `  Evolved: ${report.evolved.length}${report.evolved.length > 0 ? ` (${report.evolved.join(', ')})` : ''}`,
      `  Composed: ${report.composed.length}${report.composed.length > 0 ? ` (${report.composed.join(', ')})` : ''}`,
    ];
    return lines.join('\n');
  }

  private persistReport(report: EvolutionReport): void {
    try {
      const dir = codebotPath('health');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        codebotPath('health/last-evolution-report.json'),
        JSON.stringify(report, null, 2),
      );
    } catch { /* best effort */ }
  }
}
