import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from "remotion";

const CYAN = "#00d4ff";
const BG = "#0a0a0f";
const WHITE = "#ffffff";
const DIM = "#666677";
const GREEN = "#22c55e";
const RED = "#ff4444";
const GOLD = "#ffaa00";
const PURPLE = "#a855f7";

const FadeIn: React.FC<{ children: React.ReactNode; delay?: number }> = ({
  children,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame - delay, [0, 15], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame - delay, [0, 15], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div style={{ opacity, transform: `translateY(${y}px)` }}>{children}</div>
  );
};

// Scene 1: Hook
const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <div style={{ fontSize: 64, fontWeight: 900, fontFamily: "system-ui", color: WHITE, lineHeight: 1.2 }}>
          Your AI coding tool
        </div>
        <FadeIn delay={20}>
          <div style={{ fontSize: 64, fontWeight: 900, fontFamily: "system-ui", color: RED, lineHeight: 1.2 }}>
            isn't an agent.
          </div>
        </FadeIn>
        <FadeIn delay={45}>
          <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", marginTop: 30 }}>
            Here's how you can tell.
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Copilot comparison
const CopilotScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 52, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center" }}>
        Copilot <span style={{ color: DIM, fontSize: 36 }}>suggests code</span>
      </div>
    </FadeIn>
    <FadeIn delay={20}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        You accept. You test. You commit. You push.
      </div>
    </FadeIn>
    <FadeIn delay={40}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        You do all the work. It just types faster.
      </div>
    </FadeIn>
    <FadeIn delay={60}>
      <div style={{
        marginTop: 50, padding: "16px 40px", border: `2px solid ${GOLD}`,
        borderRadius: 12, fontSize: 24, color: GOLD, fontFamily: "system-ui",
      }}>
        That's autocomplete, not autonomy.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 3: Cursor comparison
const CursorScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 52, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center" }}>
        Cursor <span style={{ color: DIM, fontSize: 36 }}>edits your file</span>
      </div>
    </FadeIn>
    <FadeIn delay={20}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        You point. It edits. You review. You approve.
      </div>
    </FadeIn>
    <FadeIn delay={40}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        Still you driving. Still file-by-file.
      </div>
    </FadeIn>
    <FadeIn delay={60}>
      <div style={{
        marginTop: 50, padding: "16px 40px", border: `2px solid ${GOLD}`,
        borderRadius: 12, fontSize: 24, color: GOLD, fontFamily: "system-ui",
      }}>
        That's an assistant, not an agent.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 4: Devin comparison
const DevinScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 52, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center" }}>
        Devin <span style={{ color: DIM, fontSize: 36 }}>works autonomously</span>
      </div>
    </FadeIn>
    <FadeIn delay={20}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        But your code goes to their cloud.
      </div>
    </FadeIn>
    <FadeIn delay={35}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        No audit trail you control. No safety layer.
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        $500/month. Black box.
      </div>
    </FadeIn>
    <FadeIn delay={65}>
      <div style={{
        marginTop: 50, padding: "16px 40px", border: `2px solid ${RED}`,
        borderRadius: 12, fontSize: 24, color: RED, fontFamily: "system-ui",
      }}>
        That's autonomous, but ungoverned.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 5: What an agent actually does
const AgentScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: PURPLE, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 30, textAlign: "center" }}>
        A real agent
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 48, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.4 }}>
        Takes the task. Does the work.<br />
        <span style={{ color: CYAN }}>Checks its own work.</span><br />
        Shows receipts.
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ display: "flex", gap: 20, marginTop: 50, justifyContent: "center", flexWrap: "wrap" }}>
        {["Clones the repo", "Creates a branch", "Writes the fix", "Runs the tests", "Reviews its diff", "Opens the PR"].map((step, i) => (
          <FadeIn key={i} delay={55 + i * 8}>
            <div style={{
              padding: "12px 24px", background: "#111118", border: "1px solid #222233",
              borderRadius: 8, fontSize: 20, color: GREEN, fontFamily: "monospace",
            }}>
              {step}
            </div>
          </FadeIn>
        ))}
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 6: CORD safety
const SafetyScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: CYAN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 30, textAlign: "center" }}>
        Governed
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 48, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        Every tool call goes through<br />
        <span style={{ color: CYAN }}>CORD</span> <span style={{ color: DIM, fontSize: 32 }}>— Constitutional Safety</span>
      </div>
    </FadeIn>
    <FadeIn delay={35}>
      <div style={{
        background: "#111118", borderRadius: 16, padding: 40, marginTop: 40,
        border: "1px solid #222233", maxWidth: 800,
      }}>
        {[
          { label: "Risk scored", desc: "Every action gets a risk level before execution", color: GREEN },
          { label: "Policy enforced", desc: "Hard blocks on destructive operations", color: GREEN },
          { label: "Audit logged", desc: "Every decision written to JSON — traceable forever", color: GREEN },
          { label: "Self-reviewed", desc: "Agent diffs its own code: APPROVE / REVISE / REJECT", color: GREEN },
        ].map((item, i) => (
          <FadeIn key={i} delay={40 + i * 12}>
            <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
              <div style={{ fontSize: 24, color: item.color }}>✓</div>
              <div>
                <div style={{ fontSize: 24, color: WHITE, fontWeight: 700, fontFamily: "system-ui" }}>{item.label}</div>
                <div style={{ fontSize: 18, color: DIM, fontFamily: "system-ui" }}>{item.desc}</div>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 7: Local first
const LocalScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 60, fontWeight: 900, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        Your code <span style={{ color: CYAN }}>stays on your machine.</span>
      </div>
    </FadeIn>
    <FadeIn delay={25}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 30 }}>
        No uploads. No cloud processing. No trust required.
      </div>
    </FadeIn>
    <FadeIn delay={45}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 15 }}>
        Open source. Inspect every line. Fork it. Self-host it.
      </div>
    </FadeIn>
    <FadeIn delay={65}>
      <div style={{ fontSize: 32, color: GREEN, fontFamily: "system-ui", textAlign: "center", marginTop: 40, fontWeight: 700 }}>
        You own the agent. It doesn't own your data.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 8: The gap
const GapScene: React.FC = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
      <FadeIn>
        <div style={{ fontSize: 28, color: CYAN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 40, textAlign: "center" }}>
          The Market Gap
        </div>
      </FadeIn>
      {/* 2x2 grid */}
      <div style={{ position: "relative", width: 700, height: 500 }}>
        {/* Axes */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: DIM }} />
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 2, background: DIM }} />
        {/* Labels */}
        <div style={{ position: "absolute", bottom: -40, left: "50%", transform: "translateX(-50%)", color: DIM, fontSize: 20, fontFamily: "system-ui" }}>
          Autonomy →
        </div>
        <div style={{ position: "absolute", left: -40, top: "50%", transform: "translateY(-50%) rotate(-90deg)", color: DIM, fontSize: 20, fontFamily: "system-ui" }}>
          Governance →
        </div>
        {/* Copilot/Cursor */}
        <FadeIn delay={15}>
          <div style={{ position: "absolute", left: 80, bottom: 80, textAlign: "center" }}>
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: GOLD, margin: "0 auto" }} />
            <div style={{ fontSize: 18, color: GOLD, marginTop: 8, fontFamily: "system-ui" }}>Copilot / Cursor</div>
          </div>
        </FadeIn>
        {/* Devin */}
        <FadeIn delay={30}>
          <div style={{ position: "absolute", right: 80, bottom: 80, textAlign: "center" }}>
            <div style={{ width: 20, height: 20, borderRadius: "50%", background: RED, margin: "0 auto" }} />
            <div style={{ fontSize: 18, color: RED, marginTop: 8, fontFamily: "system-ui" }}>Devin</div>
          </div>
        </FadeIn>
        {/* CodeBot */}
        <FadeIn delay={50}>
          <div style={{ position: "absolute", right: 80, top: 60, textAlign: "center" }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", background: CYAN, margin: "0 auto",
              boxShadow: `0 0 20px ${CYAN}`,
            }} />
            <div style={{ fontSize: 22, color: CYAN, marginTop: 8, fontFamily: "system-ui", fontWeight: 700 }}>CodeBot AI</div>
          </div>
        </FadeIn>
        {/* Empty quadrant label */}
        <FadeIn delay={65}>
          <div style={{ position: "absolute", left: 100, top: 100, fontSize: 18, color: "#333", fontFamily: "system-ui", fontStyle: "italic" }}>
            (nobody here)
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Scene 9: CTA
const CTAScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const glowOpacity = interpolate(Math.sin(frame / 15), [-1, 1], [0.3, 0.8]);

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <FadeIn>
          <div style={{ fontSize: 42, color: DIM, fontFamily: "system-ui", marginBottom: 10 }}>
            Not a copilot. Not a black box.
          </div>
        </FadeIn>
        <FadeIn delay={15}>
          <div style={{ fontSize: 72, fontWeight: 900, color: WHITE, fontFamily: "system-ui" }}>
            Code<span style={{ color: CYAN }}>Bot</span> AI
          </div>
        </FadeIn>
        <FadeIn delay={30}>
          <div style={{ fontSize: 32, color: WHITE, fontFamily: "system-ui", marginTop: 15 }}>
            Autonomous. Governed. Yours.
          </div>
        </FadeIn>
        <FadeIn delay={45}>
          <div style={{
            marginTop: 40, padding: "18px 50px", background: CYAN, color: BG,
            fontSize: 28, fontWeight: 800, borderRadius: 12, fontFamily: "system-ui",
            display: "inline-block",
            boxShadow: `0 0 40px ${CYAN}${Math.round(glowOpacity * 255).toString(16).padStart(2, "0")}`,
          }}>
            ascendral.github.io/codebot-ai
          </div>
        </FadeIn>
        <FadeIn delay={60}>
          <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 25 }}>
            @alexpinkone · Open Source · github.com/Ascendral/codebot-ai
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Main — 60 seconds at 30fps = 1800 frames
export const NotJustATool: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: BG }}>
      <Sequence from={0} durationInFrames={120}><HookScene /></Sequence>
      <Sequence from={120} durationInFrames={150}><CopilotScene /></Sequence>
      <Sequence from={270} durationInFrames={150}><CursorScene /></Sequence>
      <Sequence from={420} durationInFrames={160}><DevinScene /></Sequence>
      <Sequence from={580} durationInFrames={180}><AgentScene /></Sequence>
      <Sequence from={760} durationInFrames={180}><SafetyScene /></Sequence>
      <Sequence from={940} durationInFrames={150}><LocalScene /></Sequence>
      <Sequence from={1090} durationInFrames={180}><GapScene /></Sequence>
      <Sequence from={1270} durationInFrames={530}><CTAScene /></Sequence>
    </AbsoluteFill>
  );
};
