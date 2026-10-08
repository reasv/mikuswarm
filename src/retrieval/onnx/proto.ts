/**
 * A minimal protobuf encoder for ONNX `ModelProto` (onnx.proto3 field numbers),
 * enough to build small computation graphs in code (the late-interaction MaxSim
 * graph, ARCHITECTURE.md §9d, and test fixtures) without a protobuf dependency.
 *
 * Covered: nodes with INT / INTS / FLOAT / FLOATS / STRING attributes, graph
 * inputs and outputs with a tensor element type and fixed or symbolic dims,
 * initializers carried as `raw_data`, and opset imports. Decoding is out of scope.
 */

/** `TensorProto.DataType` values used here. */
export const TensorType = {
  FLOAT: 1,
  UINT8: 2,
  INT8: 3,
  INT32: 6,
  INT64: 7,
  BOOL: 9,
  FLOAT16: 10,
  DOUBLE: 11,
} as const;
export type TensorElementType = (typeof TensorType)[keyof typeof TensorType];

/** `AttributeProto.AttributeType` values. */
const AttributeType = { FLOAT: 1, INT: 2, STRING: 3, FLOATS: 6, INTS: 7 } as const;

export type AttributeValue =
  | { int: number | bigint }
  | { ints: Array<number | bigint> }
  | { float: number }
  | { floats: number[] }
  | { string: string };

export interface OnnxNode {
  opType: string;
  inputs: string[];
  outputs: string[];
  name?: string;
  domain?: string;
  attributes?: Record<string, AttributeValue>;
}

/** A dimension: a fixed size, or a symbolic name (`dim_param`). */
export type OnnxDim = number | string;

export interface OnnxValueInfo {
  name: string;
  elemType: TensorElementType;
  dims: OnnxDim[];
}

export interface OnnxInitializer {
  name: string;
  dataType: TensorElementType;
  dims: number[];
  /** Little-endian element bytes (e.g. `new Uint8Array(float32Array.buffer)`). */
  raw: Uint8Array;
}

export interface OnnxGraph {
  name: string;
  nodes: OnnxNode[];
  inputs: OnnxValueInfo[];
  outputs: OnnxValueInfo[];
  initializers?: OnnxInitializer[];
}

export interface OnnxModel {
  /** Default-domain opset version. */
  opset: number;
  /** IR version (default 8, readable by every supported onnxruntime). */
  irVersion?: number;
  producerName?: string;
  graph: OnnxGraph;
}

// ---- wire-level writer -----------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED32 = 5;
const WIRE_LEN = 2;

const textEncoder = new TextEncoder();

/** Growable byte sink with protobuf primitives. */
class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }

  /** Unsigned/two's-complement varint (int64 semantics: negatives take 10 bytes). */
  varint(value: number | bigint): void {
    let v = BigInt.asUintN(64, BigInt(value));
    if (v < 0x80n) {
      this.byte(Number(v));
      return;
    }
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.byte(Number(v));
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  float32(value: number): void {
    const tmp = new Uint8Array(4);
    new DataView(tmp.buffer).setFloat32(0, value, true);
    this.bytes(tmp);
  }

  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  // field helpers
  uintField(field: number, value: number | bigint): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
  }

  floatField(field: number, value: number): void {
    this.tag(field, WIRE_FIXED32);
    this.float32(value);
  }

  bytesField(field: number, data: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(data.length);
    this.bytes(data);
  }

  stringField(field: number, value: string): void {
    this.bytesField(field, textEncoder.encode(value));
  }

  messageField(field: number, build: (w: Writer) => void): void {
    const inner = new Writer();
    build(inner);
    this.bytesField(field, inner.finish());
  }

  packedVarints(field: number, values: Array<number | bigint>): void {
    const inner = new Writer();
    for (const v of values) inner.varint(v);
    this.bytesField(field, inner.finish());
  }

  packedFloats(field: number, values: number[]): void {
    const inner = new Writer();
    for (const v of values) inner.float32(v);
    this.bytesField(field, inner.finish());
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---- ONNX messages (field numbers from onnx.proto3) -----------------------

function writeAttribute(w: Writer, name: string, value: AttributeValue): void {
  // AttributeProto: name=1, f=2, i=3, s=4, floats=7, ints=8, type=20
  w.stringField(1, name);
  if ("int" in value) {
    w.uintField(3, value.int);
    w.uintField(20, AttributeType.INT);
  } else if ("ints" in value) {
    w.packedVarints(8, value.ints);
    w.uintField(20, AttributeType.INTS);
  } else if ("float" in value) {
    w.floatField(2, value.float);
    w.uintField(20, AttributeType.FLOAT);
  } else if ("floats" in value) {
    w.packedFloats(7, value.floats);
    w.uintField(20, AttributeType.FLOATS);
  } else {
    w.stringField(4, value.string);
    w.uintField(20, AttributeType.STRING);
  }
}

function writeNode(w: Writer, node: OnnxNode, index: number): void {
  // NodeProto: input=1, output=2, name=3, op_type=4, attribute=5, domain=7
  for (const input of node.inputs) w.stringField(1, input);
  for (const output of node.outputs) w.stringField(2, output);
  w.stringField(3, node.name ?? `${node.opType}_${index}`);
  w.stringField(4, node.opType);
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    w.messageField(5, (a) => writeAttribute(a, name, value));
  }
  if (node.domain) w.stringField(7, node.domain);
}

function writeValueInfo(w: Writer, info: OnnxValueInfo): void {
  // ValueInfoProto: name=1, type=2
  // TypeProto: tensor_type=1; TypeProto.Tensor: elem_type=1, shape=2
  // TensorShapeProto: dim=1; Dimension: dim_value=1, dim_param=2
  w.stringField(1, info.name);
  w.messageField(2, (type) =>
    type.messageField(1, (tensor) => {
      tensor.uintField(1, info.elemType);
      tensor.messageField(2, (shape) => {
        for (const dim of info.dims) {
          shape.messageField(1, (d) => {
            if (typeof dim === "number") d.uintField(1, dim);
            else d.stringField(2, dim);
          });
        }
      });
    }),
  );
}

function writeInitializer(w: Writer, init: OnnxInitializer): void {
  // TensorProto: dims=1, data_type=2, name=8, raw_data=9
  if (init.dims.length > 0) w.packedVarints(1, init.dims);
  w.uintField(2, init.dataType);
  w.stringField(8, init.name);
  w.bytesField(9, init.raw);
}

function writeGraph(w: Writer, graph: OnnxGraph): void {
  // GraphProto: node=1, name=2, initializer=5, input=11, output=12
  graph.nodes.forEach((node, i) => w.messageField(1, (n) => writeNode(n, node, i)));
  w.stringField(2, graph.name);
  for (const init of graph.initializers ?? []) w.messageField(5, (t) => writeInitializer(t, init));
  for (const input of graph.inputs) w.messageField(11, (v) => writeValueInfo(v, input));
  for (const output of graph.outputs) w.messageField(12, (v) => writeValueInfo(v, output));
}

/** Serialize an ONNX model to protobuf bytes, loadable by `InferenceSession.create`. */
export function encodeModel(model: OnnxModel): Uint8Array {
  // ModelProto: ir_version=1, producer_name=2, graph=7, opset_import=8
  // OperatorSetIdProto: domain=1, version=2
  const w = new Writer();
  w.uintField(1, model.irVersion ?? 8);
  w.stringField(2, model.producerName ?? "mikuswarm");
  w.messageField(7, (g) => writeGraph(g, model.graph));
  w.messageField(8, (o) => {
    o.stringField(1, "");
    o.uintField(2, model.opset);
  });
  return w.finish();
}

/** Raw little-endian bytes of a typed array (initializer `raw_data`). */
export function rawBytes(values: Float32Array | Int32Array | BigInt64Array | Uint8Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength).slice();
}
