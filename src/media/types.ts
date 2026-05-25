export interface ImageProcessingOptions {
  maxTotalPixels: number;
  maxTotalPixelsHard: number;
  minShortestSide: number;
  maxBytes: number;
}

export interface VideoProcessingOptions {
  maxResolution: number;
  maxBytes: number;
  maxDurationSeconds: number;
  startTime?: number;
  gpuAcceleration: boolean;
  x264Preset: string;
  cachePath: string;
  cacheMaxBytes: number;
  cacheTargetBytes: number;
  timeoutMs?: number;
}

export interface AudioProcessingOptions {
  maxBytes: number;
  maxDurationSeconds: number;
  startTime?: number;
  timeoutMs?: number;
}

export interface ProcessedMedia {
  path: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  processedRange?: [number, number];
  totalDuration?: number;
}
