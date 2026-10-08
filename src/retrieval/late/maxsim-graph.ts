/**
 * The batched MaxSim graph of the exact late-interaction scorer (ARCHITECTURE.md
 * §9d "Late interaction"), built in code with the minimal ONNX encoder.
 *
 *   Q  float[q, d]     query token vectors (unit rows)
 *   D  float[b, t, d]  a batch of documents, each padded to t tokens
 *   M  float[b, 1, t]  additive mask: 0 for real tokens, -1e9 for padding
 *   S  float[b, q]     per document, each query token's best dot product
 *
 * Transpose(D, perm=[0,2,1]) → MatMul(Q, Dt) (broadcast to [b, q, t]) → Add(M)
 * → ReduceMax(axes=[2], keepdims=0). Opset 13 keeps ReduceMax's axes an
 * attribute. All dims are symbolic, so one session serves every batch shape.
 */
import { encodeModel, TensorType } from "../onnx/proto.js";

/** Additive mask value for padded document positions. */
export const MAXSIM_MASK_PAD = -1e9;

export function buildMaxSimModel(): Uint8Array {
  const F = TensorType.FLOAT;
  return encodeModel({
    opset: 13,
    graph: {
      name: "maxsim",
      nodes: [
        { opType: "Transpose", inputs: ["D"], outputs: ["Dt"], attributes: { perm: { ints: [0, 2, 1] } } },
        { opType: "MatMul", inputs: ["Q", "Dt"], outputs: ["P"] },
        { opType: "Add", inputs: ["P", "M"], outputs: ["PM"] },
        {
          opType: "ReduceMax",
          inputs: ["PM"],
          outputs: ["S"],
          attributes: { axes: { ints: [2] }, keepdims: { int: 0 } },
        },
      ],
      inputs: [
        { name: "Q", elemType: F, dims: ["q", "d"] },
        { name: "D", elemType: F, dims: ["b", "t", "d"] },
        { name: "M", elemType: F, dims: ["b", 1, "t"] },
      ],
      outputs: [{ name: "S", elemType: F, dims: ["b", "q"] }],
    },
  });
}
