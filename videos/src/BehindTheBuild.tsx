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

const StatBox: React.FC<{
  value: string;
  label: string;
  color: string;
  delay: number;
}> = ({ value, label, color, delay }) => (
  <FadeIn delay={delay}>
    <div style={{ textAlign: "center", padding: "20px 40px" }}>
      <div style={{ fontSize: 72, fontWeight: 900, color, fontFamily: "system-ui" }}>
        {value}
      </div>
      <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 8 }}>
        {label}
      </div>
    </div>
  </FadeIn>
);

// Scene 1: Title
const TitleScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <div style={{ fontSize: 80, fontWeight: 900, fontFamily: "system-ui", color: WHITE }}>
          Behind the Build
        </div>
        <FadeIn delay={20}>
          <div style={{ fontSize: 36, color: CYAN, fontFamily: "system-ui", marginTop: 20 }}>
            Code<span style={{ color: WHITE }}>Bot</span> AI
          </div>
        </FadeIn>
        <FadeIn delay={40}>
          <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 20 }}>
            The bugs, the breakthroughs, the 3AM commits
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Scene 2: Stats
const StatsScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: CYAN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 50, textAlign: "center" }}>
        By the Numbers
      </div>
    </FadeIn>
    <div style={{ display: "flex", gap: 40, flexWrap: "wrap", justifyContent: "center" }}>
      <StatBox value="1,434" label="Tests Passing" color={GREEN} delay={10} />
      <StatBox value="32" label="Built-in Tools" color={CYAN} delay={20} />
      <StatBox value="113MB" label="DMG Size" color={GOLD} delay={30} />
      <StatBox value="$0.21" label="Cost per Solve" color={GREEN} delay={40} />
    </div>
  </AbsoluteFill>
);

// Scene 3: War Story - DMG
const DmgStory: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 24, color: RED, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 4, marginBottom: 30 }}>
        Bug #1
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 48, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        The Electron app was <span style={{ color: RED }}>343MB</span>
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 32, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        Apple notarization kept timing out
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ fontSize: 32, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        72MB of devDependencies shipped to users
      </div>
    </FadeIn>
    <FadeIn delay={70}>
      <div style={{ display: "flex", alignItems: "center", gap: 30, marginTop: 50 }}>
        <div style={{ fontSize: 64, color: RED, fontFamily: "monospace", fontWeight: 900 }}>343MB</div>
        <div style={{ fontSize: 48, color: DIM }}>→</div>
        <div style={{ fontSize: 64, color: GREEN, fontFamily: "monospace", fontWeight: 900 }}>113MB</div>
      </div>
    </FadeIn>
    <FadeIn delay={85}>
      <div style={{ fontSize: 24, color: GREEN, fontFamily: "system-ui", marginTop: 20 }}>
        70% smaller. Notarized in under 2 minutes.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 4: War Story - Symlinks
const SymlinkStory: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 24, color: RED, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 4, marginBottom: 30 }}>
        Bug #2
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 44, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        Dangling symlinks crashed code signing
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{
        background: "#111118", borderRadius: 16, padding: 40, marginTop: 40,
        border: "1px solid #222233", fontFamily: "monospace", fontSize: 22, color: RED,
        maxWidth: 900, textAlign: "left",
      }}>
        <div>ENOENT: no such file or directory</div>
        <div style={{ color: DIM, marginTop: 8 }}>node_modules/.bin/prebuild-install → ???</div>
      </div>
    </FadeIn>
    <FadeIn delay={55}>
      <div style={{ fontSize: 28, color: GREEN, fontFamily: "system-ui", marginTop: 30, textAlign: "center" }}>
        Fix: scan .bin/, stat each symlink, remove the dead ones
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 5: War Story - projectRoot
const ProjectRootStory: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 24, color: RED, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 4, marginBottom: 30 }}>
        Bug #3
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 44, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        --solve wrote files to the <span style={{ color: RED }}>wrong repo</span>
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        All 8 tools used process.cwd() instead of projectRoot
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 10 }}>
        Agent cloned the target repo but wrote fixes into CodeBot's own directory
      </div>
    </FadeIn>
    <FadeIn delay={70}>
      <div style={{ fontSize: 28, color: GREEN, fontFamily: "system-ui", textAlign: "center", marginTop: 30 }}>
        Fixed across 8 tool files. PR now lands in the right repo.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 6: War Story - Linter reverting files
const LinterStory: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 24, color: RED, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 4, marginBottom: 30 }}>
        Bug #4
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 44, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        The linter kept <span style={{ color: RED }}>reverting our code</span>
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        Edit a file → linter reverts it before git commit
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{
        background: "#111118", borderRadius: 16, padding: 40, marginTop: 30,
        border: "1px solid #222233", fontFamily: "monospace", fontSize: 22, color: GREEN,
        maxWidth: 900, textAlign: "left",
      }}>
        <div style={{ color: DIM }}># The fix: Python scripts + atomic commit</div>
        <div style={{ marginTop: 8 }}>python3 /tmp/fix.py && git add && git commit</div>
        <div style={{ color: DIM, marginTop: 8 }}># Apply + commit in one shot, outrun the linter</div>
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 7: War Story - Self review
const SelfReviewStory: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 24, color: GREEN, fontFamily: "monospace", textTransform: "uppercase", letterSpacing: 4, marginBottom: 30 }}>
        Breakthrough
      </div>
    </FadeIn>
    <FadeIn delay={10}>
      <div style={{ fontSize: 44, fontWeight: 700, color: WHITE, fontFamily: "system-ui", textAlign: "center", lineHeight: 1.3 }}>
        The agent <span style={{ color: CYAN }}>reviews its own code</span>
      </div>
    </FadeIn>
    <FadeIn delay={30}>
      <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 20 }}>
        Before committing, it diffs its own changes and decides:
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ display: "flex", gap: 40, marginTop: 40, justifyContent: "center" }}>
        <div style={{ padding: "20px 40px", border: `2px solid ${GREEN}`, borderRadius: 12, fontSize: 32, color: GREEN, fontWeight: 700, fontFamily: "monospace" }}>
          APPROVE
        </div>
        <div style={{ padding: "20px 40px", border: `2px solid ${GOLD}`, borderRadius: 12, fontSize: 32, color: GOLD, fontWeight: 700, fontFamily: "monospace" }}>
          REVISE
        </div>
        <div style={{ padding: "20px 40px", border: `2px solid ${RED}`, borderRadius: 12, fontSize: 32, color: RED, fontWeight: 700, fontFamily: "monospace" }}>
          REJECT
        </div>
      </div>
    </FadeIn>
    <FadeIn delay={70}>
      <div style={{ fontSize: 24, color: DIM, fontFamily: "system-ui", textAlign: "center", marginTop: 30 }}>
        If it rejects its own work, it loops back and tries again.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 8: The result
const ResultScene: React.FC = () => (
  <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center", padding: 100 }}>
    <FadeIn>
      <div style={{ fontSize: 28, color: CYAN, fontFamily: "system-ui", textTransform: "uppercase", letterSpacing: 6, marginBottom: 40, textAlign: "center" }}>
        The Result
      </div>
    </FadeIn>
    <FadeIn delay={15}>
      <div style={{
        background: "#111118", borderRadius: 16, padding: 50, border: `1px solid ${GREEN}`,
        fontFamily: "monospace", fontSize: 24, color: WHITE, maxWidth: 800, lineHeight: 2,
      }}>
        <div><span style={{ color: CYAN }}>Issue:</span>  #2 "Add --version flag to CLI"</div>
        <div><span style={{ color: CYAN }}>Repo:</span>   Ascendral/KlomboAGI</div>
        <div><span style={{ color: CYAN }}>Files:</span>  2 changed (cli.py + test_cli.py)</div>
        <div><span style={{ color: CYAN }}>Tests:</span>  <span style={{ color: GREEN }}>PASSED</span></div>
        <div><span style={{ color: CYAN }}>Review:</span> <span style={{ color: GREEN }}>APPROVE</span></div>
        <div><span style={{ color: CYAN }}>Cost:</span>   $0.21</div>
        <div><span style={{ color: CYAN }}>Time:</span>   90 seconds</div>
        <div style={{ marginTop: 10 }}><span style={{ color: CYAN }}>PR:</span>    <span style={{ color: GREEN }}>github.com/Ascendral/KlomboAGI/pull/4</span></div>
      </div>
    </FadeIn>
    <FadeIn delay={50}>
      <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 30, textAlign: "center" }}>
        Real PR. Real repo. Fully autonomous.
      </div>
    </FadeIn>
  </AbsoluteFill>
);

// Scene 9: CTA
const CTAScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const glowOpacity = interpolate(Math.sin(frame / 15), [-1, 1], [0.3, 0.8]);

  return (
    <AbsoluteFill style={{ background: BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center", transform: `scale(${scale})` }}>
        <div style={{ fontSize: 72, fontWeight: 900, color: WHITE, fontFamily: "system-ui" }}>
          Code<span style={{ color: CYAN }}>Bot</span> AI
        </div>
        <FadeIn delay={15}>
          <div style={{ fontSize: 28, color: DIM, fontFamily: "system-ui", marginTop: 20 }}>
            Built by breaking things until they worked.
          </div>
        </FadeIn>
        <FadeIn delay={30}>
          <div style={{
            marginTop: 40, padding: "18px 50px", background: CYAN, color: BG,
            fontSize: 28, fontWeight: 800, borderRadius: 12, fontFamily: "system-ui",
            display: "inline-block",
            boxShadow: `0 0 40px ${CYAN}${Math.round(glowOpacity * 255).toString(16).padStart(2, "0")}`,
          }}>
            ascendral.github.io/codebot-ai
          </div>
        </FadeIn>
        <FadeIn delay={45}>
          <div style={{ fontSize: 22, color: DIM, fontFamily: "system-ui", marginTop: 25 }}>
            @alexpinkone · github.com/Ascendral/codebot-ai
          </div>
        </FadeIn>
      </div>
    </AbsoluteFill>
  );
};

// Main — 60 seconds total at 30fps = 1800 frames
export const BehindTheBuild: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: BG }}>
      <Sequence from={0} durationInFrames={120}><TitleScene /></Sequence>
      <Sequence from={120} durationInFrames={150}><StatsScene /></Sequence>
      <Sequence from={270} durationInFrames={180}><DmgStory /></Sequence>
      <Sequence from={450} durationInFrames={150}><SymlinkStory /></Sequence>
      <Sequence from={600} durationInFrames={150}><ProjectRootStory /></Sequence>
      <Sequence from={750} durationInFrames={150}><LinterStory /></Sequence>
      <Sequence from={900} durationInFrames={180}><SelfReviewStory /></Sequence>
      <Sequence from={1080} durationInFrames={180}><ResultScene /></Sequence>
      <Sequence from={1260} durationInFrames={540}><CTAScene /></Sequence>
    </AbsoluteFill>
  );
};
