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

export const VersionSchema = z.object({
  id,
  file: z.string().min(1),
  duration: seconds.nullable().default(null),
  fps: z.number().positive().nullable().default(null),
  addedAt: z.string(),
  note: z.string().default(""),
  shots: z.array(ShotSchema).max(200).default([]),
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

export const ProjectSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  id: ProjectIdSchema.optional(),
  name: z.string().min(1),
  fps: z.number().positive().default(30),
  videos: z.array(VideoSchema).default([]),
  lanes: z.array(LaneSchema).default([]),
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

export const NoteSchema = z
  .object({
    id,
    stage: StageSchema,
    video: z.string().nullable().default(null),
    version: z.string().nullable().default(null),
    on: z.string().nullable().default(null),
    scope: z.enum(["point", "range", "whole"]),
    t: seconds.nullable().default(null),
    tOut: seconds.nullable().default(null),
    frame: z.number().int().nonnegative().nullable().default(null),
    text: z.string().trim().min(1).max(4000),
    box: BoxSchema.nullable().default(null),
    grab: z.string().nullable().default(null),
    shot: z.object({ n: z.number().int().positive(), name: z.string() }).nullable().default(null),
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
  });
export type Note = z.infer<typeof NoteSchema>;

export const NotesFileSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  notes: z.array(NoteSchema).default([]),
});
export type NotesFile = z.infer<typeof NotesFileSchema>;

export const PicksSchema = z.object({
  schema: z.literal(1),
  rev: z.number().int().nonnegative(),
  lanes: z.record(z.string(), z.string()).default({}),
  sections: z.record(z.string(), z.string()).default({}),
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

export const FILES = {
  project: { name: "project.json", schema: ProjectSchema },
  script: { name: "script.json", schema: ScriptSchema },
  notes: { name: "notes.json", schema: NotesFileSchema },
  picks: { name: "picks.json", schema: PicksSchema },
  batches: { name: "batches.json", schema: BatchesFileSchema },
} as const;
export type FileKey = keyof typeof FILES;
export type FileData = {
  project: Project;
  script: Script;
  notes: NotesFile;
  picks: Picks;
  batches: BatchesFile;
};
