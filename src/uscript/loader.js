// UnrealScript structure loader: classes, states, functions, properties, enums, consts,
// and a bytecode decoder producing statement/expression trees.
import { Reader } from '../engine/upackage.js';
import { readProperties } from '../engine/uobject.js';

export const FUNC = {
  Final: 0x1, Defined: 0x2, Iterator: 0x4, Latent: 0x8, PreOperator: 0x10, Singular: 0x20,
  Net: 0x40, NetReliable: 0x80, Simulated: 0x100, Exec: 0x200, Native: 0x400, Event: 0x800,
  Operator: 0x1000, Static: 0x2000, NoExport: 0x4000, Const: 0x8000, Invariant: 0x10000,
};
export const CPF = {
  Edit: 0x1, Const: 0x2, Input: 0x4, ExportObject: 0x8, OptionalParm: 0x10, Net: 0x20,
  ConstRef: 0x40, Parm: 0x80, OutParm: 0x100, SkipParm: 0x200, ReturnParm: 0x400,
  CoerceParm: 0x800, Native: 0x1000, Transient: 0x2000, Config: 0x4000, Localized: 0x8000,
  Travel: 0x10000, EditConst: 0x20000, GlobalConfig: 0x40000,
};

// Token ids
export const EX = {
  LocalVariable: 0x00, InstanceVariable: 0x01, DefaultVariable: 0x02, Return: 0x04, Switch: 0x05,
  Jump: 0x06, JumpIfNot: 0x07, Stop: 0x08, Assert: 0x09, Case: 0x0A, Nothing: 0x0B, LabelTable: 0x0C,
  GotoLabel: 0x0D, EatString: 0x0E, Let: 0x0F, DynArrayElement: 0x10, New: 0x11, ClassContext: 0x12,
  MetaCast: 0x13, LetBool: 0x14, EndFunctionParms: 0x16, Self: 0x17, Skip: 0x18, Context: 0x19,
  ArrayElement: 0x1A, VirtualFunction: 0x1B, FinalFunction: 0x1C, IntConst: 0x1D, FloatConst: 0x1E,
  StringConst: 0x1F, ObjectConst: 0x20, NameConst: 0x21, RotationConst: 0x22, VectorConst: 0x23,
  ByteConst: 0x24, IntZero: 0x25, IntOne: 0x26, True: 0x27, False: 0x28, NativeParm: 0x29,
  NoObject: 0x2A, IntConstByte: 0x2C, BoolVariable: 0x2D, DynamicCast: 0x2E, Iterator: 0x2F,
  IteratorPop: 0x30, IteratorNext: 0x31, StructCmpEq: 0x32, StructCmpNe: 0x33, UnicodeStringConst: 0x34,
  StructMember: 0x36, ArrayLength: 0x37, GlobalFunction: 0x38,
  // conversions 0x39..0x5F
  RotatorToVector: 0x39, ByteToInt: 0x3A, ByteToBool: 0x3B, ByteToFloat: 0x3C, IntToByte: 0x3D,
  IntToBool: 0x3E, IntToFloat: 0x3F, BoolToByte: 0x40, BoolToInt: 0x41, BoolToFloat: 0x42,
  FloatToByte: 0x43, FloatToInt: 0x44, FloatToBool: 0x45, StringToName: 0x46, ObjectToBool: 0x47,
  NameToBool: 0x48, StringToByte: 0x49, StringToInt: 0x4A, StringToBool: 0x4B, StringToFloat: 0x4C,
  StringToVector: 0x4D, StringToRotator: 0x4E, VectorToBool: 0x4F, VectorToRotator: 0x50,
  RotatorToBool: 0x51, ByteToString: 0x52, IntToString: 0x53, BoolToString: 0x54, FloatToString: 0x55,
  ObjectToString: 0x56, NameToString: 0x57, VectorToString: 0x58, RotatorToString: 0x59,
  ExtendedNative: 0x60, FirstNative: 0x70,
};

// ---------------------------------------------------------------------------
// Bytecode decoder
// Each node: { op, mem (in-memory offset), ...operands }

class Decoder {
  constructor(r, pkg) {
    this.r = r; this.pkg = pkg; this.mem = 0;
  }
  obj() { const v = this.r.idx(); this.mem += 4; return v; }
  name() { const v = this.pkg.names[this.r.idx()]; this.mem += 4; return v; }
  u8() { this.mem += 1; return this.r.u8_(); }
  u16() { this.mem += 2; return this.r.u16(); }
  i32() { this.mem += 4; return this.r.i32(); }
  f32() { this.mem += 4; return this.r.f32(); }

  params() {
    const out = [];
    for (let g = 0; g < 64; g++) {
      const e = this.expr();
      if (e.op === EX.EndFunctionParms) break;
      out.push(e);
    }
    return out;
  }

  expr() {
    const mem = this.mem;
    const tok = this.u8();
    const n = { op: tok, mem };
    if (tok >= EX.FirstNative) { n.native = tok; n.op = EX.FirstNative; n.args = this.params(); return n; }
    if (tok >= EX.ExtendedNative) {
      n.native = ((tok - EX.ExtendedNative) << 8) + this.u8();
      n.op = EX.FirstNative; // normalize: native call
      n.args = this.params();
      return n;
    }
    switch (tok) {
      case EX.LocalVariable: case EX.InstanceVariable: case EX.DefaultVariable: case EX.NativeParm:
        n.prop = this.obj(); break;
      case EX.Return: n.expr = this.expr(); break;
      case EX.Switch: n.size = this.u8(); n.expr = this.expr(); break;
      case EX.Jump: n.target = this.u16(); break;
      case EX.JumpIfNot: n.target = this.u16(); n.expr = this.expr(); break;
      case EX.Stop: case EX.Nothing: case EX.EndFunctionParms: case EX.Self: case EX.IntZero:
      case EX.IntOne: case EX.True: case EX.False: case EX.NoObject: case EX.IteratorPop:
      case EX.IteratorNext:
        break;
      case EX.Assert: n.line = this.u16(); n.expr = this.expr(); break;
      case EX.Case: n.next = this.u16(); if (n.next !== 0xffff) n.expr = this.expr(); break;
      case EX.LabelTable: {
        // labels are aligned to 4 in memory
        n.labels = [];
        for (let g = 0; g < 1024; g++) {
          const name = this.name();
          const off = this.i32();
          if (name === 'None') break;
          n.labels.push({ name, off });
        }
        break;
      }
      case EX.GotoLabel: case EX.EatString: n.expr = this.expr(); break;
      case EX.Let: case EX.LetBool: n.lhs = this.expr(); n.rhs = this.expr(); break;
      case EX.DynArrayElement: case EX.ArrayElement: n.index = this.expr(); n.array = this.expr(); break;
      case EX.New: n.outer = this.expr(); n.name = this.expr(); n.flags = this.expr(); n.cls = this.expr(); break;
      case EX.ClassContext: case EX.Context:
        n.obj = this.expr(); n.skip = this.u16(); n.size = this.u8(); n.expr = this.expr(); break;
      case EX.MetaCast: case EX.DynamicCast: n.cls = this.obj(); n.expr = this.expr(); break;
      case EX.Skip: n.skip = this.u16(); n.expr = this.expr(); break;
      case EX.VirtualFunction: case EX.GlobalFunction: n.fname = this.name(); n.args = this.params(); break;
      case EX.FinalFunction: n.func = this.obj(); n.args = this.params(); break;
      case EX.IntConst: n.value = this.i32(); break;
      case EX.FloatConst: n.value = this.f32(); break;
      case EX.StringConst: {
        let s = '';
        for (let c; (c = this.u8()) !== 0;) s += String.fromCharCode(c);
        n.value = s; break;
      }
      case EX.UnicodeStringConst: {
        let s = '';
        for (let c; (c = this.u16()) !== 0;) s += String.fromCharCode(c);
        n.value = s; break;
      }
      case EX.ObjectConst: n.obj = this.obj(); break;
      case EX.NameConst: n.value = this.name(); break;
      case EX.RotationConst: n.value = { Pitch: this.i32(), Yaw: this.i32(), Roll: this.i32() }; break;
      case EX.VectorConst: n.value = { X: this.f32(), Y: this.f32(), Z: this.f32() }; break;
      case EX.ByteConst: case EX.IntConstByte: n.value = this.u8(); break;
      case EX.BoolVariable: n.expr = this.expr(); break;
      case EX.Iterator: n.expr = this.expr(); n.end = this.u16(); break;
      case EX.StructCmpEq: case EX.StructCmpNe: n.struct = this.obj(); n.a = this.expr(); n.b = this.expr(); break;
      case EX.StructMember: n.prop = this.obj(); n.expr = this.expr(); break;
      case EX.ArrayLength: n.expr = this.expr(); break; // HP extension: dynamic array length
      default:
        if (tok >= 0x39 && tok < 0x60) { n.conv = tok; n.expr = this.expr(); break; }
        throw new Error(`unknown token 0x${tok.toString(16)} at mem ${mem}`);
    }
    return n;
  }
}

export function decodeScript(r, pkg, scriptSize) {
  const d = new Decoder(r, pkg);
  const stmts = [];
  while (d.mem < scriptSize) {
    const s = d.expr();
    stmts.push(s);
    if (s.op === EX.LabelTable) {
      // label tables are terminal; account for alignment padding in memory
      break;
    }
  }
  return { stmts, size: d.mem };
}

// ---------------------------------------------------------------------------
// Structure readers

function readField(r) {
  return { superField: r.idx(), next: r.idx() };
}

function readStruct(r, pkg, s) {
  Object.assign(s, readField(r));
  s.scriptText = r.idx();
  s.children = r.idx();
  s.friendlyName = pkg.names[r.idx()];
  s.line = r.i32();
  s.textPos = r.i32();
  s.scriptSize = r.i32();
  const start = r.pos;
  if (s.scriptSize > 0) {
    const dec = decodeScript(r, pkg, s.scriptSize);
    s.code = dec.stmts;
    s.decodedSize = dec.size;
  } else s.code = [];
  s.fileScriptLen = r.pos - start;
  return s;
}

export function loadScriptObject(pkg, exp) {
  const r = pkg.readerFor(exp);
  const cls = exp.className;
  const o = { kind: cls, name: exp.name, exp, pkg };
  // Objects start with tagged properties (always "None" here) — except UClass objects
  if (cls !== 'Class') readProperties(r);
  switch (cls) {
    case 'Function':
      readStruct(r, pkg, o);
      o.iNative = r.u16();
      o.operPrecedence = r.u8_();
      o.flags = r.u32();
      if (o.flags & FUNC.Net) o.repOffset = r.u16();
      break;
    case 'State':
      readStruct(r, pkg, o);
      o.probeMask = [r.u32(), r.u32()];
      o.ignoreMask = [r.u32(), r.u32()];
      o.labelTableOffset = r.u16();
      o.stateFlags = r.u32();
      break;
    case 'Class': {
      readStruct(r, pkg, o);
      o.probeMask = [r.u32(), r.u32()];
      o.ignoreMask = [r.u32(), r.u32()];
      o.labelTableOffset = r.u16();
      o.stateFlags = r.u32();
      o.classFlags = r.u32();
      r.skip(16);
      const nd = r.idx();
      o.deps = [];
      for (let i = 0; i < nd; i++) { o.deps.push(r.idx()); r.u32(); r.u32(); }
      const ni = r.idx();
      for (let i = 0; i < ni; i++) r.idx();
      o.within = r.idx();
      o.configName = pkg.names[r.idx()];
      o.defaultsPos = r.pos;
      o.defaults = readProperties(r);
      o._left = r.end - r.pos;
      break;
    }
    case 'Struct':
      readStruct(r, pkg, o);
      break;
    case 'Enum': {
      Object.assign(o, readField(r));
      const n = r.idx();
      o.names = [];
      for (let i = 0; i < n; i++) o.names.push(pkg.names[r.idx()]);
      break;
    }
    case 'Const':
      Object.assign(o, readField(r));
      o.value = r.str();
      break;
    default:
      if (cls.endsWith('Property')) {
        Object.assign(o, readField(r));
        o.arrayDim = r.u16();
        o.elementSize = r.u16();
        o.propFlags = r.u32();
        o.category = pkg.names[r.idx()];
        if (o.propFlags & CPF.Net) o.repOffset = r.u16();
        switch (cls) {
          case 'ByteProperty': o.enum = r.idx(); break;
          case 'ObjectProperty': o.propClass = r.idx(); break;
          case 'ClassProperty': o.propClass = r.idx(); o.metaClass = r.idx(); break;
          case 'StructProperty': o.struct = r.idx(); break;
          case 'FixedArrayProperty': o.inner = r.idx(); o.count = r.idx(); break;
          case 'ArrayProperty': o.inner = r.idx(); break;
          case 'MapProperty': o.key = r.idx(); o.value = r.idx(); break;
        }
        o._left = r.end - r.pos;
      }
  }
  return o;
}
