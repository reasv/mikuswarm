export { CaptionWorkerPool, type CaptionWorkerPoolOptions, type CaptionConfig } from "./worker-pool.js";
export { CaptionWorker, type CaptionWorkerOptions } from "./worker.js";
export { InferenceClient, type InferenceClientOptions, type CaptionRequest, type CaptionResponse } from "./inference-client.js";
export { describeMedia, type CaptionModelConfig, type DescribeMediaOptions, type DescribeMediaResult, type MediaModality } from "./describe.js";
export { isAnimatedImage, convertAnimatedToVideo, extractFirstFrame } from "./animated.js";
export { resolveCaptionCost, type CaptionCostBlock, type ResolveCaptionCostArgs, type CaptionCostResolution } from "./cost.js";
