import { z } from "zod";

export const STAGES = ["script", "picture", "voice", "music", "sfx", "mix"] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const LaneStageSchema = z.enum(["voice", "music", "sfx"]);
export type LaneStage = z.infer<typeof LaneStageSchema>;

const id = z.string().min(1).max(64);
const seconds = z.number().nonnegative();

export const ProjectIdSchema = z.string().regex(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);

export const ShotSchema = z.object({
  n: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  start: z.number().nonnegative(),
  tag: z.string().trim().max(24).default(""),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ProxySchema = z.object({
  /** Manifest path, always "proxies/<film-slug>_<version>_proxy.mp4". */
  file: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type Proxy = z.infer<typeof ProxySchema>;

export const VersionSchema = z.object({
  id,
  file: z.string().min(1),
  duration: seconds.nullable().default(null),
  fps: z.number().positive().nullable().default(null),
  addedAt: z.string(),
  note: z.string().default(""),
  // §22.3: a short label the agent writes, shown in the version list. The 48-character limit is
  // enforced where labels come in (the route, the tool, the CLI). A hand-edited longer one still
  // loads, and shortLabel shows it cut (§22.9, R2).
  label: z.string().default(""),
  shots: z.array(ShotSchema).max(200).default([]),
  // §19.5: a lightweight H.264 copy for smooth preview. Set only once a render has completed.
  proxy: ProxySchema.nullable().default(null),
});
export type Version = z.infer<typeof VersionSchema>;

export const VideoSchema = z.object({
  id,
  name: z.string().min(1),
  versions: z.array(VersionSchema).default([]),
  lockedVersion: z.string().nullable().default(null),
});
export type Video = z.infer<typeof VideoSchema>;

export const CueSchema = z.object({ id, name: z.string().min(1), t: seconds });
export type Cue = z.infer<typeof CueSchema>;

export const VariantSchema = z.object({
  id,
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  cues: z.array(CueSchema).default([]),
});
export type Variant = z.infer<typeof VariantSchema>;

export const LaneSchema = z.object({
  id,
  stage: LaneStageSchema,
  name: z.string().min(1),
  variants: z.array(VariantSchema).default([]),
});
export type Lane = z.infer<typeof LaneSchema>;

export const FileKindSchema = z.enum(["doc", "image", "caption", "export", "delivery", "edit"]);
export type FileKind = z.infer<typeof FileKindSchema>;

export const FileEntrySchema = z.object({
  id,
  kind: FileKindSchema,
  file: z.string().min(1),
  name: z.string().min(1).max(120),
  note: z.string().max(500).default(""),
  video: z.string().nullable().default(null),
  addedAt: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const ProjectSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  id: ProjectIdSchema.optional(),
  name: z.string().min(1),
  fps: z.number().positive().default(30),
  videos: z.array(VideoSchema).default([]),
  lanes: z.array(LaneSchema).default([]),
  files: z.array(FileEntrySchema).default([]),
  // §19.5: start a proxy straight away for a new cut that meets the criteria. Off by default.
  autoProxy: z.boolean().default(false),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TakeSchema = z.object({
  id,
  file: z.string().min(1),
  duration: seconds.nullable().default(null),
  forText: z.string(),
});
export type Take = z.infer<typeof TakeSchema>;

export const SectionStatusSchema = z.enum(["draft", "approved", "flagged"]);
export const SectionSchema = z
  .object({
    id,
    start: seconds,
    end: seconds,
    current: z.string(),
    proposed: z.string().nullable().default(null),
    direction: z.string().default(""),
    status: SectionStatusSchema.default("draft"),
    takes: z.array(TakeSchema).default([]),
  })
  .refine((s) => s.end > s.start, { message: "end must be after start", path: ["end"] });
export type Section = z.infer<typeof SectionSchema>;

export const ScriptSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  wordsPerSecond: z.number().positive().default(2.6),
  sections: z.array(SectionSchema).default([]),
});
export type Script = z.infer<typeof ScriptSchema>;

export const BoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

// §14.5/§17.1: a range note on an audio tab can carry up to four quick marks. Louder/quieter
// need a dB amount (chosen from 1, 2, 3, 6 or 9 in the UI, 3 the default); rise/fall never carry
// one. Both rules, plus "no duplicate kinds" and "only on audio-ish stages", are enforced on the
// note as a whole below, since they depend on more than one mark (or on the note's stage).
export const MarkSchema = z.object({
  kind: z.enum(["rise", "fall", "louder", "quieter"]),
  db: z.number().min(0.5).max(24).optional(),
});
export type Mark = z.infer<typeof MarkSchema>;

const MARK_STAGES: readonly Stage[] = ["voice", "music", "sfx", "mix"];

/** "Rise" | "Fall" | "Louder 3 dB" | "Quieter 3 dB". */
export function markLabel(m: Mark): string {
  const label = m.kind === "rise" ? "Rise" : m.kind === "fall" ? "Fall" : m.kind === "louder" ? "Louder" : "Quieter";
  return m.db === undefined ? label : `${label} ${m.db} dB`;
}

export const NoteSchema = z
  .object({
    id,
    stage: StageSchema,
    video: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    // What the note is about (§5, §17): null on Picture (and the whole mix on Mix); "<lane>/<variant>"
    // for a variant; "<lane>/<variant>:<cue>" for an SFX cue; "vo" for the assembled read (or Mix's
    // VO lane); "<section>:<take>" for a take; a section id for a section. Older notes may carry a
    // bare variant id, "<variant>:<cue>" or a bare cue id; they still resolve. Not checked here,
    // so every older file still loads.
    on: z
      .string()
      .nullable()
      .default(null)
      .describe('What the note is about: null (Picture, or the whole mix), "<lane>/<variant>", "<lane>/<variant>:<cue>", "vo", "<section>:<take>" or a section id.'),
    scope: z.enum(["point", "range", "whole"]),
    t: seconds.nullable().default(null),
    tOut: seconds.nullable().default(null),
    frame: z.number().int().nonnegative().nullable().default(null),
    text: z.string().trim().min(1).max(4000),
    box: BoxSchema.nullable().default(null),
    grab: z.string().nullable().default(null),
    shot: z.object({ n: z.number().int().positive(), name: z.string() }).nullable().default(null),
    marks: z.array(MarkSchema).max(4).default([]),
    status: z.enum(["todo", "done"]).default("todo"),
    reply: z.string().default(""),
    fixT: seconds.nullable().default(null),
    fixVersion: z.string().nullable().default(null),
    batch: z.string().nullable().default(null),
    createdAt: z.string(),
    by: z.enum(["user", "agent"]).default("user"),
  })
  .superRefine((n, ctx) => {
    if (n.scope === "point" && n.t === null) ctx.addIssue({ code: "custom", path: ["t"], message: "a point note needs t" });
    if (n.scope === "range") {
      if (n.t === null || n.tOut === null) ctx.addIssue({ code: "custom", path: ["tOut"], message: "a range note needs t and tOut" });
      else if (n.tOut <= n.t) ctx.addIssue({ code: "custom", path: ["tOut"], message: "tOut must be after t" });
    }
    if (n.scope === "whole" && (n.t !== null || n.tOut !== null))
      ctx.addIssue({ code: "custom", path: ["scope"], message: "a whole-track note has no t or tOut" });

    if (n.marks.length > 0 && !MARK_STAGES.includes(n.stage)) {
      ctx.addIssue({ code: "custom", path: ["marks"], message: `marks don't apply to the ${n.stage} stage` });
    }
    const seenKinds = new Set<string>();
    for (let i = 0; i < n.marks.length; i++) {
      const m = n.marks[i];
      if ((m.kind === "louder" || m.kind === "quieter") && m.db === undefined) {
        ctx.addIssue({ code: "custom", path: ["marks", i, "db"], message: `${m.kind} needs a db amount` });
      }
      if ((m.kind === "rise" || m.kind === "fall") && m.db !== undefined) {
        ctx.addIssue({ code: "custom", path: ["marks", i, "db"], message: `${m.kind} doesn't take a db amount` });
      }
      if (seenKinds.has(m.kind)) {
        ctx.addIssue({ code: "custom", path: ["marks", i, "kind"], message: `duplicate mark "${m.kind}"` });
      }
      seenKinds.add(m.kind);
    }
  });
export type Note = z.infer<typeof NoteSchema>;

export const NotesFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  notes: z.array(NoteSchema).default([]),
});
export type NotesFile = z.infer<typeof NotesFileSchema>;

// §19.6: a Mix lane's level, in dB. −24..6 in 0.5 dB steps; PUT /api/picks enforces the range and
// step (a value outside it, or off the step, is a 400), so the stored file is never checked again here.
export const LEVEL_MIN = -24;
export const LEVEL_MAX = 6;
export const LEVEL_STEP = 0.5;

export const LevelsSchema = z.object({ voice: z.number(), music: z.number(), sfx: z.number() }).partial().default({});
export type Levels = z.infer<typeof LevelsSchema>;

export const PicksSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  lanes: z.record(z.string(), z.string()).default({}),
  sections: z.record(z.string(), z.string()).default({}),
  // §19.6: each Mix lane's level in dB, defaulting to 0 (absent). Keyed the same as LaneStage.
  levels: LevelsSchema,
});
export type Picks = z.infer<typeof PicksSchema>;

export const BatchSchema = z.object({
  id,
  stage: StageSchema,
  noteIds: z.array(z.string()).default([]),
  sectionIds: z.array(z.string()).default([]),
  sentAt: z.string(),
  prompt: z.string(),
});
export type Batch = z.infer<typeof BatchSchema>;

export const BatchesFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  batches: z.array(BatchSchema).default([]),
});
export type BatchesFile = z.infer<typeof BatchesFileSchema>;

// §20.6: the found files the user dismissed ("Not these"), as manifest paths. The candidates
// themselves live in the server's memory; only this list is kept. Created on its first write.
export const FoundFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  dismissed: z.array(z.string().max(1024)).max(10000).default([]),
  // §20.7: the kinds an agent's `include` settled for a cut (the anchor: its video and version
  // ids), so the scoring never also adds a file of that kind for that cut, on any later scan,
  // start-up or restart. Files from before this field read as empty.
  settled: z
    .array(
      z.object({
        video: z.string().max(200),
        version: z.string().max(200),
        kinds: z.array(z.enum(["voice", "music", "sfx", "cut", "other"])).max(5),
      }),
    )
    .max(200)
    .default([]),
});
export type FoundFileData = z.infer<typeof FoundFileSchema>;

export const FILES = {
  project: { name: "project.json", schema: ProjectSchema },
  script: { name: "script.json", schema: ScriptSchema },
  notes: { name: "notes.json", schema: NotesFileSchema },
  picks: { name: "picks.json", schema: PicksSchema },
  batches: { name: "batches.json", schema: BatchesFileSchema },
  found: { name: "found.json", schema: FoundFileSchema },
} as const;
export type FileKey = keyof typeof FILES;
export type FileData = {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
  found: FoundFileData;
};
