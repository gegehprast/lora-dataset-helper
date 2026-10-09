// Types shared by the server and the web UI.

export type Framing = "closeup" | "half" | "full"
export type CaptionStyle = "natural" | "tags"
export type ImageStatus = "pending" | "selected" | "reserve" | "rejected"
export type Override = "include" | "exclude" | null

/**
 * Crop rectangle, normalized 0–1 relative to the image as displayed (after EXIF rotation).
 * Stored per image; the input file is never changed.
 */
/** Mirror applied after EXIF rotation: horizontal, vertical or both. */
export type Flip = "h" | "v" | "hv"

/** What to do when a JPEG can't be rotated perfectly losslessly (size not a multiple of 16). */
export type JpegImperfect = "trim" | "png"

export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

/** Review attributes the selection can spread across. */
export const VARIETY_ATTRIBUTES = [
  "outfit",
  "setting",
  "expression",
  "view",
  "lighting",
  "camera",
] as const
export type VarietyAttribute = (typeof VARIETY_ATTRIBUTES)[number]

export const VARIETY_LABELS: Record<VarietyAttribute, string> = {
  outfit: "Outfit",
  setting: "Setting",
  expression: "Expression",
  view: "View",
  lighting: "Lighting",
  camera: "Camera angle",
}

export interface Settings {
  /** Token that names the character in captions, e.g. "ohwx woman" or "jane_doe". */
  triggerWord: string
  /** Generic class noun used next to the trigger, e.g. "woman". */
  subjectClass: string
  targetCount: number
  /** Images whose short side is below this are rejected. */
  minShortSide: number
  /** Short side at which an image gets the full resolution score. */
  preferredShortSide: number
  /** Laplacian variance of the main face crop; lower is rejected as blurry. */
  minFaceSharpness: number
  /** Cosine similarity to the identity centroid; lower is rejected as a different person. */
  identityThreshold: number
  /** Faces smaller than this fraction of image height don't count as a second person. */
  otherPersonMinFace: number
  dedupPhashDistance: number
  dedupClipSimilarity: number
  framingMix: Record<Framing, number>
  /** 0 = pure quality ranking, 1 = maximum variety. */
  diversity: number
  /** Review attributes whose repetition the selection penalises. */
  varietyAttributes: Record<VarietyAttribute, boolean>
  /** Image ids whose main face defines the character's identity. Empty = automatic. */
  referenceImageIds: number[]
  tagModel: string
  /**
   * Review only the best `reviewMultiplier × targetCount` candidates by local score, plus
   * replacements as needed. 0 = review every candidate.
   */
  reviewMultiplier: number
  captionModel: string
  /** Never send this dataset's images to Venice (review and captioning are blocked). Enforced server-side. */
  localOnly: boolean
  /** Only send images to models Venice marks as private. Enforced server-side. */
  privateModelsOnly: boolean
  captionStyle: CaptionStyle
  /** Hair can change between photos; describe it so it doesn't get baked into the trigger. */
  captionDescribeHair: boolean
  captionInstructions: string
  concurrency: number
  /** Export: trim < 16 px of edge to keep a lossless JPEG, or write a (larger) PNG. */
  exportJpegImperfect: JpegImperfect
}

export const DEFAULT_SETTINGS: Settings = {
  triggerWord: "",
  subjectClass: "woman",
  targetCount: 30,
  minShortSide: 768,
  preferredShortSide: 1024,
  minFaceSharpness: 40,
  identityThreshold: 0.4,
  otherPersonMinFace: 0.08,
  dedupPhashDistance: 8,
  dedupClipSimilarity: 0.95,
  framingMix: { closeup: 0.4, half: 0.35, full: 0.25 },
  diversity: 0.5,
  varietyAttributes: {
    outfit: true,
    setting: true,
    expression: true,
    view: true,
    lighting: false,
    camera: false,
  },
  referenceImageIds: [],
  tagModel: "google-gemma-4-31b-it",
  reviewMultiplier: 3,
  captionModel: "qwen-3-8-27b",
  localOnly: false,
  privateModelsOnly: true,
  captionStyle: "natural",
  captionDescribeHair: true,
  captionInstructions: "",
  concurrency: 4,
  exportJpegImperfect: "trim",
}

export const ISSUES = [
  "blurry",
  "motion_blur",
  "noise_or_compression",
  "bad_lighting",
  "cropped_head",
  "cropped_limbs",
  "face_occluded",
  "sunglasses",
  "multiple_people",
  "watermark_or_text",
  "heavy_filter_or_edit",
  "bad_anatomy",
  "unusual_crop",
] as const
export type Issue = (typeof ISSUES)[number]

/** Issues the vision model can report that reject an image outright; the rest only lower its score. */
export const HARD_ISSUES: Issue[] = [
  "cropped_head",
  "face_occluded",
  "multiple_people",
  "watermark_or_text",
  "heavy_filter_or_edit",
  "bad_anatomy",
]

export const EXPRESSIONS = [
  "neutral",
  "smile",
  "laugh",
  "serious",
  "playful",
  "surprised",
  "sad",
  "other",
] as const
export const SETTINGS_KINDS = [
  "home",
  "indoor_other",
  "urban",
  "nature",
  "beach_water",
  "studio",
  "vehicle",
  "event",
  "other",
] as const
export const LIGHTING_KINDS = [
  "daylight",
  "indoor_natural",
  "indoor_artificial",
  "studio",
  "flash",
  "golden_hour",
  "low_light",
  "mixed",
] as const

/** Bump when the review schema changes; older reviews are redone. */
export const TAGS_VERSION = 2

export interface VisionTags {
  v?: number
  framing: Framing
  view: "front" | "three_quarter" | "profile" | "back"
  camera: "eye_level" | "high" | "low"
  pose: string
  expression: (typeof EXPRESSIONS)[number] | string
  /** Short free text, e.g. "black hoodie, blue jeans"; grouped per dataset into outfit groups. */
  outfit: string
  setting?: (typeof SETTINGS_KINDS)[number]
  background: string
  lighting: (typeof LIGHTING_KINDS)[number] | string
  issues: Issue[]
  quality: number
  note: string
}

export interface FaceInfo {
  bbox: [number, number, number, number] // normalized x1, y1, x2, y2
  det: number
  sharpness: number
  pose: [number, number, number] | null // pitch, yaw, roll
  age: number | null
  sex: string | null
}

/** Worker metrics as stored (embeddings are kept separately). */
export interface Analysis {
  error?: string
  width: number
  height: number
  sharpness: number
  brightness: number
  darkClip: number
  brightClip: number
  phash: string
  aesthetic: number
  faces: FaceInfo[]
}

export interface ImageMetrics {
  aesthetic: number | null
  sharpness: number | null
  faceSharpness: number | null
  faceHeight: number | null
  yaw: number | null
  identity: number | null
  faceCount: number
  brightness: number | null
}

export interface ImageRecord {
  id: number
  relPath: string
  hash: string
  /** Thumbnail id (includes the crop, if any): /thumbs/<thumb>.webp */
  thumb: string
  crop: Crop | null
  flip: Flip | null
  width: number | null
  height: number | null
  status: ImageStatus
  score: number | null
  reasons: string[]
  framing: Framing | null
  dupOf: number | null
  override: Override
  caption: string | null
  /** The crop changed after this caption was written. */
  captionStale: boolean
  tags: VisionTags | null
  /** Outfit group label shared by images with the same outfit (after review). */
  outfitGroup: string | null
  metrics: ImageMetrics
}

export interface DatasetSummary {
  name: string
  imageCount: number
  analyzed: number
  tagged: number
  selected: number
  captioned: number
}

export type JobKind =
  | "scan"
  | "analyze"
  | "tag"
  | "select"
  | "caption"
  | "export"
  | "auto"

export interface JobState {
  dataset: string
  kind: JobKind
  stage: string
  done: number
  total: number
  running: boolean
  error: string | null
  message: string | null
  startedAt: number
  finishedAt: number | null
}

export interface VeniceModel {
  id: string
  name: string
  /** Venice's label: "private" (no data retained) or "anonymized" (third-party provider). */
  privacy: string | null
  vision: boolean
  /** Needs client-side end-to-end encryption, which the app doesn't implement. */
  e2ee: boolean
  schema: boolean
  priceIn: number | null
  priceOut: number | null
}

/** Human-readable labels for rejection reasons. */
export const REASON_LABELS: Record<string, string> = {
  unreadable: "Unreadable file",
  low_resolution: "Resolution too low",
  no_face: "No face found",
  different_person: "Different person",
  blurry_face: "Blurry face",
  bad_exposure: "Bad exposure",
  multiple_people: "Multiple people",
  duplicate: "Near-duplicate",
  low_quality: "Low quality (AI)",
  not_selected: "Not picked (reserve)",
  manual: "Excluded manually",
  cropped_head: "Head cropped",
  face_occluded: "Face hidden",
  watermark_or_text: "Watermark / text",
  heavy_filter_or_edit: "Heavy filter / edit",
  bad_anatomy: "Bad anatomy",
}
