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
        <div style={{ fontSize: 56, fontWeight: 900, fontFamily: "system-ui", color: WHITE, lineHeight: 1.3 }}>
          We're building the ultimate
        </div>
        <FadeIn delay={15}>
          <div style={{ fontSize: 72, fontWeight: 900, fontFamily: "system-ui", color: CYAN, lineHeight: 1.2 }}>
            autonomous AI agent.
          </div>
        </FadeIn>
        <FadeIn delay={40}>
          <div style={{ fontSize: 32, color: DIM, fontFamily: "system-ui", marginTop: 30 }}>
            We can't do it alone.
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: What we've built
const BuiltScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: CYAN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 40, textAlign: "center" }}>
        What we've built so far
      </div>
    </FadeIn>
    <div style={{ display: "flex", gap: 30, flexWrap: "wrap", justifyContent: "center", maxWidth: 1400 }}>
      {[
        { name: "CodeBot AI", desc: "Governed autonomous coding agent", stat: "32 tools · 1,434 tests", color: CYAN },
        { name: "CORD", desc: "Constitutional safety engine", stat: "Risk scoring · Policy enforcement", color: GREEN },
        { name: "SPARK", desc: "Soul engine for agents", stat: "Emotion · Personality · Memory", color: PURPLE },
        { name: "KlomboAGI", desc: "Experimental cognition runtime", stat: "World model · Planner · Critic", color: GOLD },
      ].map((item, i) => (
        <FadeIn key={i} delay={10 + i * 12}>
          <div style={{
            background: "#111118", border: `1px solid ${item.color}33`, borderRadius: 16,
            padding: "30px 35px", width: 340, textAlign: "center",
          }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: item.color, fontFamily: "system-ui" }}>{item.name}</div>
            <div style={{ fontSize: 18, color: WHITE, marginTop: 8, fontFamily: "system-ui" }}>{item.desc}</div>
            <div style={{ fontSize: 15, color: DIM, marginTop: 8, fontFamily: "monospace" }}>{item.stat}</div>
          </div>
        </FadeIn>
      ))}
    </div>
  </AbsoluteFill>
);

// Scene 3: KlomboAGI deep dive
const KlomboScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: GOLD, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 30, textAlign: "center" }}>
        Experimental
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 60, fontWeight: 900, color: WHITE, fontFamily: "system-ui", textAlign: "center" }}>
        Klombo<span style={{ color: GOLD }}>AGI</span>
      </div>
    </FadeIn>
    <FadeIn delay={25}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 15 }}>
        Autonomous cognition runtime — the path toward AGI tooling
      </div>
    </FadeIn>
    <FadeIn delay={40}>
      <div style={{
        background: "#111118", borderRadius: 16, padding: 40, marginTop: 40,
        border: "1px solid #222233", maxWidth: 800, fontFamily: "monospace", fontSize: 20, lineHeight: 2,
      }}>
        <div style={{ color: GOLD }}>Persistent memory across sessions</div>
        <div style={{ color: GOLD }}>World model that updates from experience</div>
        <div style={{ color: GOLD }}>Planner → Verifier → Critic loop</div>
        <div style={{ color: GOLD }}>LLM-powered reasoning (Claude + GPT)</div>
        <div style={{ color: GOLD }}>207 tests passing · Python · Open source</div>
      </div>
    </FadeIn>
    <FadeIn delay={70}>
      <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 25 }}>
        github.com/Ascendral/KlomboAGI
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 4: The vision
const VisionScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: PURPLE, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 30, textAlign: "center" }}>
        The Vision
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 44, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.4 }}>
        An agent that doesn't just write code.
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 44, fontWeight: 700, color: CYAN, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.4, marginTop: 10 }}>
        It thinks. It learns. It remembers.
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ fontSize: 44, fontWeight: 700, color: GREEN, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.4, marginTop: 10 }}>
        And it governs itself.
      </div>
    </FadeIn>
    <FadeIn delay={70}>
      <div style={{ fontSize: 26, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 40 }}>
        We're not building a chatbot. We're building a colleague.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 5: What we need
const NeedScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: GREEN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 40, textAlign: "center" }}>
        We need you
      </div>
    </FadeIn>
    <div style={{ maxWidth: 900 }}>
      {[
        { role: "Agent Engineers", desc: "Build tool chains, reasoning loops, and self-improvement systems", color: CYAN },
        { role: "Safety Researchers", desc: "Help us prove CORD works — constitutional AI for autonomous agents", color: GREEN },
        { role: "ML Engineers", desc: "Fine-tune models, optimize inference, push toward local-first AI", color: PURPLE },
        { role: "Open Source Contributors", desc: "Every PR matters. Every issue filed makes us better.", color: GOLD },
      ].map((item, i) => (
        <FadeIn key={i} delay={10 + i * 15}>
          <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 25 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, flexShrink: 0 }} />
            <div>
              <span style={{ fontSize: 26, color: item.color, fontWeight: 700, fontFamily: "system-ui" }}>{item.role}</span>
              <span style={{ fontSize: 22, color: DIM, fontFamily: "system-ui" }}> — {item.desc}</span>
            </div>
          </div>
        </FadeIn>
      ))}
    </div>
  </AbsoluteFill>
);

// Scene 6: Open source pitch
const OpenSourceScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 52, fontWeight: 900, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        Everything is <span style={{ color: GREEN }}>open source.</span>
      </div>
    </FadeIn>
    <FadeIn delay={20}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 25 }}>
        No gatekeeping. No waitlists. No closed beta.
      </div>
    </FadeIn>
    <FadeIn delay={40}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        Fork it. Break it. Make it better.
      </div>
    </FadeIn>
    <FadeIn delay={60}>
      <div style={{ display: "flex", gap: 30, marginTop: 50, justifyContent: "center" }}>
        {[
          { label: "CodeBot AI", url: "github.com/Ascendral/codebot-ai" },
          { label: "KlomboAGI", url: "github.com/Ascendral/KlomboAGI" },
        ].map((repo, i) => (
          <FadeIn key={i} delay={65 + i * 10}>
            <div style={{
              padding: "20px 35px", background: "#111118", border: "1px solid #222233",
              borderRadius: 12, textAlign: "center",
            }}>
              <div style={{ fontSize: 24, color: WHITE, fontWeight: 700, fontFamily: "system-ui" }}>{repo.label}</div>
              <div style={{ fontSize: 16, color: CYAN, fontFamily: "monospace", marginTop: 6 }}>{repo.url}</div>
            </div>
          </FadeIn>
        ))}
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 7: CTA
const CTAScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const glowOpacity = interpolate(Math.sin(frame / 15), [-1, 1], [0.3, 0.8]);

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <FadeIn>
          <div style={{ fontSize: 52, fontWeight: 900, color: WHITE, fontFamily: "system-ui" }}>
            Let's build <span style={{ color: CYAN }}>AGI tooling</span>
          </div>
        </FadeIn>
        <FadeIn delay={15}>
          <div style={{ fontSize: 36, color: DIM, fontFamily: "system-ui", marginTop: 15 }}>
            together.
          </div>
        </FadeIn>
        <FadeIn delay={35}>
          <div style={{
            marginTop: 40, padding: "18px 50px", background: CYAN, color: BG,
            fontSize: 28, fontWeight: 800, borderRadius: 12, fontFamily: "system-ui",
            display: "inline-block",
            boxShadow: `0 0 40px ${CYAN}${Math.round(glowOpacity * 255).toString(16).padStart(2, "0")}`,
          }}>
            ascendral.github.io/codebot-ai
          </div>
        </FadeIn>
        <FadeIn delay={50}>
          <div style={{ fontSize: 24, color: WHITE, fontFamily: "system-ui", marginTop: 30 }}>
            Star the repos. Open an issue. Send a PR. DM me.
          </div>
        </FadeIn>
        <FadeIn delay={65}>
          <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 20 }}>
            @alexpinkone · Ascendral · Let's create.
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

export const CallToAction: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: BG }}>
      <Sequence from={0} durationInFrames={120}><HookScene /></Sequence>
      <Sequence from={120} durationInFrames={180}><BuiltScene /></Sequence>
      <Sequence from={300} durationInFrames={210}><KlomboScene /></Sequence>
      <Sequence from={510} durationInFrames={180}><VisionScene /></Sequence>
      <Sequence from={690} durationInFrames={180}><NeedScene /></Sequence>
      <Sequence from={870} durationInFrames={180}><OpenSourceScene /></Sequence>
      <Sequence from={1050} durationInFrames={750}><CTAScene /></Sequence>
    </AbsoluteFill>
  );
};
