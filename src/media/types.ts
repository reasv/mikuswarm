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
  cachePath: string;
}

export interface AudioProcessingOptions {
  maxBytes: number;
  maxDurationSeconds: number;
  startTime?: number;
}

export interface ProcessedMedia {
  path: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
  processedRange?: [number, number];
  totalDuration?: number;
}
