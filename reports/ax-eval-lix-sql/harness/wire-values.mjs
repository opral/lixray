import { Buffer } from "node:buffer";

export const CANONICAL_BASE64_PATTERN =
  /^$|^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/;

export function decodeWireParam(value, { wireFormat, Value }) {
  if (wireFormat === "primitive") {
    return decodePrimitiveParam(value, Value);
  }
  return decodeTaggedParam(value, Value);
}

function decodePrimitiveParam(value, Value) {
  if (value === null) return Value.null();
  if (typeof value === "boolean") return Value.boolean(value);
  if (typeof value === "string") return Value.text(value);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      value < Number.MIN_SAFE_INTEGER ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "Native numeric parameters must be finite and within the safe-integer magnitude.",
      );
    }
    return Number.isSafeInteger(value) ? Value.integer(value) : Value.real(value);
  }

  const object = wireObject(value);
  switch (object.kind) {
    case "blob":
      assertExactKeys(object, ["kind", "base64"]);
      return Value.blob(decodeCanonicalBase64(object.base64));
    case "json":
      assertExactKeys(object, ["kind", "value"]);
      return Value.json(object.value);
    case "float":
      assertExactKeys(object, ["kind", "value"]);
      if (typeof object.value !== "number" || !Number.isFinite(object.value)) {
        throw new Error("Explicit SQL REAL parameters must be finite.");
      }
      return Value.real(object.value);
    case "null":
    case "bool":
    case "int":
    case "text":
      throw new Error(
        `Legacy tagged ${JSON.stringify(object.kind)} parameters are not supported by the primitive contract.`,
      );
    default:
      throw new Error(`Unknown wire value kind: ${String(object.kind)}`);
  }
}

function decodeTaggedParam(value, Value) {
  const object = wireObject(value);
  switch (object.kind) {
    case "null":
      assertExactKeys(object, ["kind"], ["value"]);
      if (object.value !== undefined && object.value !== null) {
        throw new Error("Tagged NULL value must be null when present.");
      }
      return Value.null();
    case "bool":
      assertExactKeys(object, ["kind", "value"]);
      if (typeof object.value !== "boolean") {
        throw new Error("Tagged Boolean value must be a Boolean.");
      }
      return Value.boolean(object.value);
    case "int":
      assertExactKeys(object, ["kind", "value"]);
      if (typeof object.value !== "number") {
        throw new Error("Tagged integer value must be a number.");
      }
      return Value.integer(object.value);
    case "float":
      assertExactKeys(object, ["kind", "value"]);
      if (typeof object.value !== "number") {
        throw new Error("Tagged REAL value must be a number.");
      }
      return Value.real(object.value);
    case "text":
      assertExactKeys(object, ["kind", "value"]);
      if (typeof object.value !== "string") {
        throw new Error("Tagged text value must be a string.");
      }
      return Value.text(object.value);
    case "blob":
      assertExactKeys(object, ["kind", "base64"]);
      return Value.blob(decodeCanonicalBase64(object.base64));
    case "json":
      assertExactKeys(object, ["kind", "value"]);
      return Value.json(object.value);
    default:
      throw new Error(`Unknown wire value kind: ${String(object.kind)}`);
  }
}

function wireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid wire value.");
  }
  if (!Object.hasOwn(value, "kind") || typeof value.kind !== "string") {
    throw new Error("Wire value kind is required.");
  }
  return value;
}

function assertExactKeys(object, required, optional = []) {
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      throw new Error(`Wire value property ${JSON.stringify(key)} is required.`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Wire value has unexpected properties: ${unexpected.join(", ")}.`);
  }
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || !CANONICAL_BASE64_PATTERN.test(value)) {
    throw new Error("BLOB payload must use canonical standard base64.");
  }
  return Uint8Array.from(Buffer.from(value, "base64"));
}
