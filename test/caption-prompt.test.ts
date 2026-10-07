import { describe, expect, test } from "bun:test";
import { buildPrompt, clean } from "../src/pipeline/caption";
import { DEFAULT_SETTINGS, type Settings } from "../src/types";

const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, triggerWord: "jdoe", ...over });

describe("buildPrompt", () => {
  test("natural style names the subject and lists what to leave out", () => {
    const p = buildPrompt(s());
    expect(p).toContain('Start the caption with "jdoe"');
    expect(p).toContain("a woman");
    expect(p).toContain("eye color");
    expect(p).toContain("hairstyle and hair color"); // hair is described by default
  });

  test("turning off hair moves it to the leave-out list", () => {
    const p = buildPrompt(s({ captionDescribeHair: false }));
    const [describe, leaveOut] = p.split("Do not describe");
    expect(describe).not.toContain("hair");
    expect(leaveOut).toContain("hair color and hairstyle");
  });

  test("tag style asks for the trigger as the first tag", () => {
    expect(buildPrompt(s({ captionStyle: "tags" }))).toContain("The first tag must be exactly: jdoe");
  });

  test("extra instructions are appended", () => {
    expect(buildPrompt(s({ captionInstructions: "Mention the tattoo." }))).toContain("Additional instructions: Mention the tattoo.");
  });
});

describe("clean", () => {
  test("strips prefixes, quotes and extra whitespace", () => {
    expect(clean('Caption:  "jdoe   smiling at the camera."', s())).toBe("jdoe smiling at the camera.");
  });

  test("adds the trigger word when the model left it out", () => {
    expect(clean("A woman smiling.", s())).toBe("jdoe, A woman smiling.");
  });

  test("matches the trigger word case-insensitively", () => {
    expect(clean("JDoe smiling.", s())).toBe("JDoe smiling.");
  });
});
