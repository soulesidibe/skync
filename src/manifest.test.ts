import { describe, it, expect } from "vitest";
import {
  parseManifest,
  mergeManifests,
  expandDest,
  slugFromRepo,
  findOrCreateRemote,
  upsertSkill,
  serializeManifest,
  ManifestValidationError,
  type Manifest,
  type Remote,
} from "./manifest.js";

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const text = `
remotes:
  pocock:
    repo: https://github.com/mattpocock/skills.git
    ref: main
skills:
  - name: gridmy
    remote: pocock
    src: skills/gridmy
    dest: ~/.claude/skills/gridmy
`;
    const m = parseManifest(text);
    expect(m.remotes.pocock.repo).toBe("https://github.com/mattpocock/skills.git");
    expect(m.remotes.pocock.ref).toBe("main");
    expect(m.skills).toHaveLength(1);
    expect(m.skills[0].name).toBe("gridmy");
  });

  it("treats an empty document as an empty manifest", () => {
    expect(parseManifest("")).toEqual({ remotes: {}, skills: [] });
  });

  it("treats an empty mapping as an empty manifest", () => {
    expect(parseManifest("{}")).toEqual({ remotes: {}, skills: [] });
  });

  it("rejects a non-object root", () => {
    expect(() => parseManifest("- a\n- b")).toThrow(ManifestValidationError);
    expect(() => parseManifest("hello")).toThrow(ManifestValidationError);
  });

  it("rejects skills that are not a list", () => {
    const text = `skills:\n  foo: bar\n`;
    expect(() => parseManifest(text)).toThrow(ManifestValidationError);
  });

  it("rejects a skill missing a required field", () => {
    const text = `
remotes:
  r:
    repo: https://example.com/r.git
skills:
  - name: a
    remote: r
    src: x
`;
    expect(() => parseManifest(text)).toThrow(/missing a 'dest'/);
  });

  it("rejects malformed YAML syntax", () => {
    const text = `remotes: [unterminated`;
    expect(() => parseManifest(text)).toThrow(ManifestValidationError);
  });

  it("rejects a skill referencing an unknown remote", () => {
    const text = `
skills:
  - name: a
    remote: ghost
    src: x
    dest: y
`;
    expect(() => parseManifest(text)).toThrow(/unknown remote 'ghost'/);
  });

  it("rejects a remote missing repo", () => {
    const text = `remotes:\n  r:\n    ref: main\n`;
    expect(() => parseManifest(text)).toThrow(/missing a 'repo'/);
  });
});

describe("mergeManifests", () => {
  const remote = (repo: string): Remote => ({ repo });

  it("gives project skills precedence on name clash", () => {
    const project: Manifest = {
      remotes: { p: remote("https://example.com/p.git") },
      skills: [{ name: "shared", remote: "p", src: "a", dest: "pdest" }],
    };
    const global: Manifest = {
      remotes: { g: remote("https://example.com/g.git") },
      skills: [{ name: "shared", remote: "g", src: "b", dest: "gdest" }],
    };
    const merged = mergeManifests(project, global);
    const shared = merged.skills.find((s) => s.name === "shared");
    expect(shared?.dest).toBe("pdest");
    expect(shared?.remote).toBe("p");
  });

  it("keeps non-clashing entries from both sides", () => {
    const project: Manifest = {
      remotes: { p: remote("https://example.com/p.git") },
      skills: [{ name: "ponly", remote: "p", src: "a", dest: "d1" }],
    };
    const global: Manifest = {
      remotes: { g: remote("https://example.com/g.git") },
      skills: [{ name: "gonly", remote: "g", src: "b", dest: "d2" }],
    };
    const merged = mergeManifests(project, global);
    expect(merged.skills.map((s) => s.name).sort()).toEqual(["gonly", "ponly"]);
    expect(Object.keys(merged.remotes).sort()).toEqual(["g", "p"]);
  });

  it("gives project remotes precedence on key clash", () => {
    const project: Manifest = {
      remotes: { shared: remote("https://example.com/project.git") },
      skills: [],
    };
    const global: Manifest = {
      remotes: { shared: remote("https://example.com/global.git") },
      skills: [],
    };
    const merged = mergeManifests(project, global);
    expect(merged.remotes.shared.repo).toBe("https://example.com/project.git");
  });

  it("does not mutate its inputs", () => {
    const project: Manifest = { remotes: {}, skills: [] };
    const global: Manifest = {
      remotes: { g: remote("https://example.com/g.git") },
      skills: [{ name: "a", remote: "g", src: "s", dest: "d" }],
    };
    mergeManifests(project, global);
    expect(project.skills).toHaveLength(0);
    expect(Object.keys(project.remotes)).toHaveLength(0);
  });
});

describe("expandDest", () => {
  const home = "/home/me";
  const baseDir = "/proj";

  it("expands a bare tilde to home", () => {
    expect(expandDest("~", { home, baseDir })).toBe("/home/me");
  });

  it("expands a leading tilde-slash to home", () => {
    expect(expandDest("~/.claude/skills/x", { home, baseDir })).toBe(
      "/home/me/.claude/skills/x",
    );
  });

  it("leaves ~user literal", () => {
    expect(expandDest("~bob/x", { home, baseDir })).toBe("~bob/x");
  });

  it("leaves an absolute path unchanged", () => {
    expect(expandDest("/etc/x", { home, baseDir })).toBe("/etc/x");
  });

  it("resolves a relative path against baseDir", () => {
    expect(expandDest(".claude/skills/x", { home, baseDir })).toBe(
      "/proj/.claude/skills/x",
    );
  });
});

describe("slugFromRepo", () => {
  it("derives slug from an https url", () => {
    expect(slugFromRepo("https://github.com/mattpocock/skills")).toBe("skills");
  });

  it("strips a trailing .git", () => {
    expect(slugFromRepo("https://github.com/mattpocock/skills.git")).toBe("skills");
  });

  it("strips a trailing slash", () => {
    expect(slugFromRepo("https://github.com/mattpocock/skills/")).toBe("skills");
  });

  it("handles SSH shorthand", () => {
    expect(slugFromRepo("git@github.com:mattpocock/skills.git")).toBe("skills");
  });
});

describe("findOrCreateRemote", () => {
  it("creates a new remote named from the repo slug", () => {
    const { remotes, name } = findOrCreateRemote(
      {},
      { repo: "https://github.com/mattpocock/skills.git" },
    );
    expect(name).toBe("skills");
    expect(remotes.skills.repo).toBe("https://github.com/mattpocock/skills.git");
  });

  it("reuses an existing remote with a matching normalized url", () => {
    const existing = {
      skills: { repo: "https://github.com/mattpocock/skills.git" },
    };
    const { remotes, name } = findOrCreateRemote(existing, {
      repo: "git@github.com:mattpocock/skills",
    });
    expect(name).toBe("skills");
    expect(Object.keys(remotes)).toHaveLength(1);
  });

  it("dedups scheme-style ssh against an https remote", () => {
    const existing = {
      r: { repo: "https://github.com/u/r" },
    };
    const { remotes, name } = findOrCreateRemote(existing, {
      repo: "ssh://git@github.com/u/r.git",
    });
    expect(name).toBe("r");
    expect(Object.keys(remotes)).toHaveLength(1);
  });

  it("dedups scheme-style ssh against shorthand ssh", () => {
    const existing = {
      r: { repo: "git@github.com:u/r" },
    };
    const { remotes, name } = findOrCreateRemote(existing, {
      repo: "ssh://git@github.com/u/r.git",
    });
    expect(name).toBe("r");
    expect(Object.keys(remotes)).toHaveLength(1);
  });

  it("keeps distinct repos separate", () => {
    const existing = { a: { repo: "https://github.com/x/a.git" } };
    const { remotes, name } = findOrCreateRemote(existing, {
      repo: "https://github.com/x/b.git",
    });
    expect(name).toBe("b");
    expect(Object.keys(remotes).sort()).toEqual(["a", "b"]);
  });

  it("honors a --remote name override", () => {
    const { remotes, name } = findOrCreateRemote(
      {},
      { repo: "https://github.com/x/skills.git", remote: "custom" },
    );
    expect(name).toBe("custom");
    expect(remotes.custom).toBeDefined();
  });

  it("suffixes on a slug collision with a different repo", () => {
    const existing = { skills: { repo: "https://github.com/other/skills.git" } };
    const { remotes, name } = findOrCreateRemote(existing, {
      repo: "https://github.com/mine/skills.git",
    });
    expect(name).toBe("skills-2");
    expect(Object.keys(remotes).sort()).toEqual(["skills", "skills-2"]);
  });

  it("records the ref on a newly created remote", () => {
    const { remotes, name } = findOrCreateRemote(
      {},
      { repo: "https://github.com/x/skills.git", ref: "v1.2.3" },
    );
    expect(remotes[name].ref).toBe("v1.2.3");
  });

  it("does not mutate the input map", () => {
    const existing = { a: { repo: "https://github.com/x/a.git" } };
    findOrCreateRemote(existing, { repo: "https://github.com/x/b.git" });
    expect(Object.keys(existing)).toEqual(["a"]);
  });
});

describe("upsertSkill", () => {
  const skill = (name: string, src: string) => ({
    name,
    remote: "r",
    src,
    dest: `~/.claude/skills/${name}`,
  });

  it("appends a new skill", () => {
    const m: Manifest = { remotes: { r: { repo: "u" } }, skills: [skill("a", "a")] };
    const out = upsertSkill(m, skill("b", "b"));
    expect(out.skills.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("replaces an existing skill in place without duplicating", () => {
    const m: Manifest = {
      remotes: { r: { repo: "u" } },
      skills: [skill("a", "old"), skill("b", "b")],
    };
    const out = upsertSkill(m, skill("a", "new"));
    expect(out.skills.map((s) => s.name)).toEqual(["a", "b"]);
    expect(out.skills[0].src).toBe("new");
  });

  it("does not mutate the input", () => {
    const m: Manifest = { remotes: {}, skills: [skill("a", "a")] };
    upsertSkill(m, skill("a", "new"));
    expect(m.skills[0].src).toBe("a");
  });
});

describe("serializeManifest", () => {
  it("round-trips through parseManifest", () => {
    const m: Manifest = {
      remotes: { pocock: { repo: "https://github.com/mattpocock/skills.git", ref: "main" } },
      skills: [
        { name: "gridmy", remote: "pocock", src: "skills/gridmy", dest: "~/.claude/skills/gridmy" },
      ],
    };
    expect(parseManifest(serializeManifest(m))).toEqual(m);
  });

  it("is idempotent and orders remote keys deterministically", () => {
    const m: Manifest = {
      remotes: { zeta: { repo: "z" }, alpha: { repo: "a" } },
      skills: [],
    };
    const once = serializeManifest(m);
    expect(serializeManifest(parseManifest(once))).toBe(once);
    expect(once.indexOf("alpha")).toBeLessThan(once.indexOf("zeta"));
  });
});
