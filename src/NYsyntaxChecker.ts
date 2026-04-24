import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ==============================
// NY 指令集
// ==============================
const NY_INSTRUCTIONS = new Set([
  // 算术指令
  'ANDAR', 'IORAR', 'XORAR', 'ANDIA', 'IORIA', 'XORIA',
  'ADDAR', 'SUBAR', 'ADCAR', 'SBCAR', 'ADDIA', 'SUBIA', 'ADCIA', 'SBCIA',
  'RRR', 'RLR', 'COMR', 'INCR', 'DECR', 'CLRA', 'CLRR', 'DAA', 'CMPAR',
  
  // 条件指令
  'BTRSC', 'BTRSS', 'INCRSZ', 'DECRSZ',
  
  // 数据传输指令
  'MOVAR', 'MOVR', 'MOVIA', 'IOST', 'IOSTR', 'SFUN', 'SFUNR', 'T0MD', 'T0MDR',
  
  // 其他指令
  'NOP', 'SLEEP', 'CLRWDT', 'ENI', 'DISI', 'INT',
  'RET', 'RETIE', 'RETIA', 'CALLA', 'GOTOA', 'LCALL', 'LGOTO', 'TABLEA',
  
  // 位操作指令
  'BSR', 'BCR',
  
  // 特殊指令
  'SWAPR'
]);

// 伪指令
const NY_PSEUDO = new Set([
  'MACRO', 'ENDM', 'ORG', 'END', 'EQU', 'DB', 'DW', 'CBLOCK', 'ENDC',
  '.ADJUST_IC', 'ELSE', 'ENDC', 'ENDFOR', 'ENDIF',
  'ENDS', 'ENDSW', 'ENDW', 'ERROR', 'EXITM', 'EXPAND',
  'FOR', 'LINES', 'LIST', 'LOCAL', 'MAXMACRODEPTH',
  'MESSG', 'NEWPAGE', 'NOEXPAND', 'ORGALIGN', 'RADIX',
  'REPEAT', 'SUBTITLE', 'SWITCH', 'TITLE', 'UNTIL',
  'VARIABLE', 'WHILE', '.ALIGN2'
]);

// 预处理条件指令 (支持 #IF / IF / .IF 等多种格式)
const NY_CONDITIONAL_PSEUDO = new Set([
  'IF', 'IFDEF', 'IFNDEF', 'ELIF', 'ELSE', 'ENDIF'
]);

// #define 类伪指令
const NY_DEFINE_PSEUDO = new Set([
  '#DEFINE', '#INCLUDE', 'INCLUDE',
  '#IF', '#IFDEF', '#IFNDEF', '#ENDIF',
  '#ELSE', '#ELIF', '#UNDEFINE', '#INCLUDATA'
]);

// 立即数指令（操作数为立即数，需要验证 0-255）
const NY_IMMEDIATE_INSTRUCTIONS = new Set([
  'ANDIA', 'IORIA', 'XORIA', 'ADDIA', 'SUBIA', 'ADCIA', 'SBCIA', 'MOVIA', 'RETIA'
]);

// RAM 地址指令（第一个操作数为 RAM 地址，需要检查是否定义）
const NY_RAM_INSTRUCTIONS = new Set([
  'ANDAR', 'IORAR', 'XORAR', 'ADDAR', 'SUBAR', 'ADCAR', 'SBCAR',
  'COMR', 'INCR', 'DECR', 'CLRR', 'CMPAR',
  'BTRSC', 'BTRSS', 'INCRSZ', 'DECRSZ',
  'MOVAR', 'MOVR', 'IOST', 'IOSTR', 'SFUN', 'SFUNR',
  'BSR', 'BCR', 'RRR', 'RLR', 'SWAPR'
]);

// 操作数规则
const NY_RULES: { [key: string]: { operands: number } } = {
  // 算术指令
  'ANDAR': { operands: 2 }, 'IORAR': { operands: 2 }, 'XORAR': { operands: 2 },
  'ADDAR': { operands: 2 }, 'SUBAR': { operands: 2 }, 'ADCAR': { operands: 2 }, 'SBCAR': { operands: 2 },
  'COMR': { operands: 2 }, 'INCR': { operands: 2 }, 'DECR': { operands: 2 },
  'CMPAR': { operands: 1 },
  'ANDIA': { operands: 1 }, 'IORIA': { operands: 1 }, 'XORIA': { operands: 1 },
  'ADDIA': { operands: 1 }, 'SUBIA': { operands: 1 }, 'ADCIA': { operands: 1 }, 'SBCIA': { operands: 1 },
  'CLRA': { operands: 0 }, 'CLRR': { operands: 1 }, 'DAA': { operands: 0 },
  
  // 条件指令
  'BTRSC': { operands: 2 }, 'BTRSS': { operands: 2 },
  'INCRSZ': { operands: 2 }, 'DECRSZ': { operands: 2 },
  
  // 数据传输指令
  'MOVAR': { operands: 1 }, 'MOVR': { operands: 2 }, 'MOVIA': { operands: 1 },
  'IOST': { operands: 1 }, 'IOSTR': { operands: 1 },
  'SFUN': { operands: 1 }, 'SFUNR': { operands: 1 },
  'T0MD': { operands: 0 }, 'T0MDR': { operands: 0 },
  
  // 其他指令
  'NOP': { operands: 0 }, 'SLEEP': { operands: 0 }, 'CLRWDT': { operands: 0 },
  'ENI': { operands: 0 }, 'DISI': { operands: 0 }, 'INT': { operands: 0 },
  'RET': { operands: 0 }, 'RETIE': { operands: 0 }, 'RETIA': { operands: 1 },
  'CALLA': { operands: 0 }, 'GOTOA': { operands: 0 },
  'LCALL': { operands: 1 }, 'LGOTO': { operands: 1 },
  'TABLEA': { operands: 0 },
  
  // 位操作指令
  'BSR': { operands: 2 }, 'BCR': { operands: 2 },
  
  // 特殊指令
  'RRR': { operands: 2 }, 'RLR': { operands: 2 },
  'SWAPR': { operands: 2 }
};

// 判断是否为宏定义行
function isMacroDefinition(text: string): { isMacro: boolean; macroName: string } {
  // 匹配 <宏名> <空格> MACRO 格式
  const match = text.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+MACRO\b/i);
  if (match) {
    return { isMacro: true, macroName: match[1].toUpperCase() };
  }
  return { isMacro: false, macroName: '' };
}

// 展开 #define
function expandDefines(text: string, defines: Map<string, string>): string {
  let result = text;
  let changed = true;
  // 递归展开嵌套的宏定义（如 ad10→d87→bb3→y38→39）
  while (changed) {
    changed = false;
    defines.forEach((value, key) => {
      const regex = new RegExp(`\\b${key}\\b`, 'gi');
      const newResult = result.replace(regex, value);
      if (newResult !== result) {
        result = newResult;
        changed = true;
      }
    });
  }
  return result;
}

// 解析预处理器条件块
function parsePreprocessorBlocks(lines: string[]): Map<number, { active: boolean; reason: string }> {
  const lineStates = new Map<number, { active: boolean; reason: string }>();
  let depth = 0;
  let active = true;
  const condStack: { active: boolean; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    const lineState = { active, reason: '' as string };

    // 跳过注释和空行
    if (!text || text.startsWith(';') || text.startsWith('//')) {
      lineStates.set(i, { active: true, reason: '' });
      continue;
    }

    // #ifdef
    const ifdefMatch = text.match(/^#\s*IFDEF\s+(\w+)/i);
    if (ifdefMatch) {
      condStack.push({ active, line: i });
      lineState.reason = `IFDEF ${ifdefMatch[1]}`;
      lineStates.set(i, lineState);
      continue;
    }

    // #ifndef
    const ifndefMatch = text.match(/^#\s*IFNDEF\s+(\w+)/i);
    if (ifndefMatch) {
      condStack.push({ active, line: i });
      lineState.reason = `IFNDEF ${ifndefMatch[1]}`;
      lineStates.set(i, lineState);
      continue;
    }

    // #if
    const ifMatch = text.match(/^#\s*IF\s+/i);
    if (ifMatch) {
      condStack.push({ active, line: i });
      lineState.reason = text.substring(0, 30);
      lineStates.set(i, lineState);
      continue;
    }

    // #else / #elif
    if (/^#\s*EL(IF|SE)\b/i.test(text)) {
      if (condStack.length > 0) {
        const prev = condStack[condStack.length - 1];
        lineState.reason = text;
        lineStates.set(i, lineState);
      }
      continue;
    }

    // #endif
    if (/^#\s*ENDIF\b/i.test(text)) {
      if (condStack.length > 0) {
        condStack.pop();
      }
      lineState.reason = 'ENDIF';
      lineStates.set(i, lineState);
      continue;
    }

    lineStates.set(i, { active: true, reason: '' });
  }

  return lineStates;
}

// 递归收集单个文件中的符号
// defines Map: 符号名 -> 原始定义值（如 "0x38" 或 "next"）
function collectSymbolsFromFile(filePath: string, visited: Set<string>): {
  labels: Set<string>;
  defines: Map<string, string>;
  macros: Set<string>;
  includes: string[];
} {
  const labels = new Set<string>();
  const defines = new Map<string, string>();
  const macros = new Set<string>();
  const includes: string[] = [];

  if (!fs.existsSync(filePath) || visited.has(filePath)) {
    return { labels, defines, macros, includes };
  }
  visited.add(filePath);

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const dir = path.dirname(filePath);

  let inCblock = false;
  let cblockStartNum = 0;
  let cblockCurrentNum = 0;

  for (const line of lines) {
    const trimLine = line.trim();
    if (!trimLine || trimLine.startsWith(';') || trimLine.startsWith('//')) continue;

    // 处理 cblock 开始
    const cblockMatch = trimLine.match(/^\s*CBLOCK\s+(\S+)/i);
    if (cblockMatch) {
      const startNumStr = cblockMatch[1];
      const startNum = parseNumber(startNumStr);
      if (startNum !== null && startNum >= 0 && startNum <= 255) {
        inCblock = true;
        cblockStartNum = startNum;
        cblockCurrentNum = cblockStartNum;
      }
      continue;
    }

    // 处理 cblock 结束
    if (/^\s*ENDC\b/i.test(trimLine)) {
      inCblock = false;
      continue;
    }

    // 处理 cblock 内部的变量定义
    if (inCblock) {
      // 提取变量名（可以是多个变量，用空格或换行分隔）
      const vars = trimLine.split(/\s+/).filter(v => v && !v.startsWith(';'));
      for (const varName of vars) {
        if (varName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
          const upperName = varName.toUpperCase();
          labels.add(upperName);
          defines.set(upperName, cblockCurrentNum.toString());
          cblockCurrentNum++;
        }
      }
      continue;
    }

    // 收集标签行 (LABEL:)
    const labelMatch = trimLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (labelMatch) {
      labels.add(labelMatch[1].toUpperCase());
    }

    // #DEFINE xxx yyy 或 #DEFINE xxx 0x38 格式
    // 支持: #DEFINE temp yel, #DEFINE temp 0x38, #DEFINE temp 38
    // 先去除尾部注释再匹配
    const defLineWithoutComment = trimLine.replace(/;.*$/, '').trim();
    const defMatch = defLineWithoutComment.match(/#\s*DEFINE\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)/i);
    if (defMatch) {
      const name = defMatch[1].toUpperCase();
      const value = defMatch[2].trim();
      defines.set(name, value);
    }

    // EQU xxx yyy 格式
    // 支持: temp EQU next, temp EQU 0x38, temp EQU 38
    // 先去除尾部注释再匹配
    const lineWithoutComment = trimLine.replace(/;.*$/, '').trim();
    const equMatch = lineWithoutComment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)/i);
    if (equMatch) {
      const name = equMatch[1].toUpperCase();
      const value = equMatch[2].trim();
      labels.add(name);
      defines.set(name, value);
    }

    // VARIABLE 定义
    const varMatch = lineWithoutComment.match(/^\s*VARIABLE\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (varMatch) {
      const name = varMatch[1].toUpperCase();
      labels.add(name);
    }

    // MACRO
    const macroInfo = isMacroDefinition(trimLine);
    if (macroInfo.isMacro) {
      macros.add(macroInfo.macroName);
      labels.add(macroInfo.macroName);
    }

    // 收集 include 文件路径
    const includeMatch = trimLine.match(/#include\s+([">])([^>"]+)\1/i);
    if (includeMatch) {
      const incPath = path.join(dir, includeMatch[2]);
      includes.push(incPath);
    }
  }

  return { labels, defines, macros, includes };
}

// 收集标签、宏、定义（递归收集所有 include 文件）
function collectSymbols(document: vscode.TextDocument, docDir: string): {
  labels: Set<string>;
  defines: Map<string, string>;
  macros: Set<string>;
} {
  const labels = new Set<string>();
  const defines = new Map<string, string>();
  const macros = new Set<string>();
  const visited = new Set<string>();

  // 递归收集函数
  function collectRecursively(filePath: string, isMainFile: boolean = false) {
    const result = collectSymbolsFromFile(filePath, visited);

    // 合并符号（主文件的符号优先，不被子文件覆盖）
    result.labels.forEach(l => labels.add(l));
    result.macros.forEach(m => macros.add(m));
    // 只有当主文件或符号未定义时才设置 defines
    result.defines.forEach((v, k) => {
      if (isMainFile || !defines.has(k)) {
        defines.set(k, v);
      }
    });

    // 递归处理所有 include 文件
    for (const incPath of result.includes) {
      collectRecursively(incPath, false);
    }
  }

  // 首先收集主文件（主文件符号优先）
  collectRecursively(document.uri.fsPath, true);

  return { labels, defines, macros };
}

// 解析数字字符串，返回数值或 null
function parseNumber(str: string): number | null {
  const trimmed = str.trim();
  // 十六进制: 0x38, 0xFF
  if (/^0x[0-9A-Fa-f]+$/i.test(trimmed)) {
    const val = parseInt(trimmed, 16);
    return isNaN(val) ? null : val;
  }
  // 十六进制: 38H, FFH, 003H (结尾带 H 表示十六进制)
  if (/^[0-9A-Fa-f]+H$/i.test(trimmed)) {
    const val = parseInt(trimmed.slice(0, -1), 16);
    return isNaN(val) ? null : val;
  }
  // 十进制: 38, 255
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }
  return null;
}

// 追踪符号到最终数值
// 返回最终数值（0-255），或 null 表示无法解析为数字，或 undefined 表示未定义
function resolveToValue(symbol: string, defines: Map<string, string>, visited: Set<string>): number | null {
  const upper = symbol.toUpperCase();

  // 防止循环引用
  if (visited.has(upper)) {
    return null; // 循环引用，无法确定值
  }
  visited.add(upper);

  const value = defines.get(upper);
  if (value === undefined) {
    return null; // 未定义
  }

  // 尝试直接解析为数字
  const num = parseNumber(value);
  if (num !== null) {
    return num;
  }

  // 如果包含运算符，尝试计算表达式（如 39+5、0x20+1）
  if (/[+\-*/|\(\)\^!]/.test(value)) {
    const evalResult = evaluateExpression(value, defines);
    if (evalResult !== null) {
      return evalResult;
    }
    // 表达式计算失败，说明有未定义的符号（不是在追踪链中，而是表达式本身有问题）
    return null;
  }

  // 如果不是数字，可能是另一个符号，递归追踪
  return resolveToValue(value, defines, visited);
}

// 计算表达式值（支持 +、-、*、/、|、&、^、! 等运算符）
function evaluateExpression(expr: string, defines: Map<string, string>): number | null {
  try {
    // 先展开表达式中的所有符号
    let expanded = expr;
    let changed = true;
    while (changed) {
      changed = false;
      defines.forEach((value, key) => {
        const regex = new RegExp(`\\b${key}\\b`, 'gi');
        const newExpanded = expanded.replace(regex, value);
        if (newExpanded !== expanded) {
          expanded = newExpanded;
          changed = true;
        }
      });
    }

    // 递归展开嵌套的符号（如 0x04|1 已经是最终形式）
    expanded = expandDefines(expanded, defines);

    // 替换十六进制格式
    expanded = expanded.replace(/0x([0-9A-Fa-f]+)/gi, (_, hex) => parseInt(hex, 16).toString());

    // 移除空格
    const safeExpr = expanded.replace(/\s/g, '');

    // 尝试直接计算表达式
    const result = new Function(`return (${safeExpr})`)();
    if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
      return Math.floor(result);
    }
    return null;
  } catch {
    return null;
  }
}

// 检查操作数是否为有效的 0-255 数值
// 对程序指令有效，伪指令行不检查
function validateOperand(operand: string, defines: Map<string, string>): { valid: boolean; value?: number; error?: string } {
  const trimmed = operand.trim();

  // 处理带逗号的操作数格式（如 porta,3、ad10,0、0x04|1,3）
  // 验证第一个部分（寄存器/符号）是否定义，逗号后的位值由汇编器处理
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',');
    const firstPart = parts[0].trim();
    if (firstPart) {
      // 如果第一个部分是数字（可能是展开后的结果），直接检查范围
      const firstPartNum = parseNumber(firstPart);
      if (firstPartNum !== null) {
        // 是数字，检查范围
        if (firstPartNum >= 0 && firstPartNum <= 255) {
          return { valid: true, value: firstPartNum };
        } else {
          return { valid: false, error: `数值 ${firstPartNum} 超出范围 (0-255)` };
        }
      }
      // 第一个部分是符号，尝试追踪到数字值
      const visited = new Set<string>();
      const resolved = resolveToValue(firstPart, defines, visited);
      if (resolved !== null) {
        // 能追踪到值，检查范围
        if (resolved >= 0 && resolved <= 255) {
          return { valid: true, value: resolved };
        } else {
          return { valid: false, error: `符号 ${firstPart} 的值 ${resolved} 超出范围 (0-255)` };
        }
      }
      // 无法追踪到纯数字值，可能是带运算符的表达式（如 0x04|1、39+5）
      // 尝试计算表达式
      if (/[+\-*/|\(\)\^!]/.test(firstPart)) {
        const evalResult = evaluateExpression(firstPart, defines);
        if (evalResult !== null) {
          if (evalResult >= 0 && evalResult <= 255) {
            return { valid: true, value: evalResult };
          } else {
            return { valid: false, error: `表达式值 ${evalResult} 超出范围 (0-255)` };
          }
        }
        // 表达式包含符号，检查基础符号是否定义
        const hasDefinedSymbol = /^([A-Za-z_][A-Za-z0-9_]*)/.test(firstPart) && 
                                  defines.has(firstPart.toUpperCase());
        if (hasDefinedSymbol) {
          return { valid: true }; // 基础符号已定义，表达式由汇编器处理
        }
        return { valid: false, error: `符号 ${firstPart} 未定义` };
      }
      // 纯符号但未定义
      return { valid: false, error: `符号 ${firstPart} 未定义` };
    }
    return { valid: false, error: `操作数格式错误` };
  }

  // 处理带运算符的表达式（如 HeadRAM_ADR+31、EndRAM_ADR-1、val*2+1、port|0x10、0|(0<<1)）
  if (/[+\-*/|\(\)\^!]/.test(trimmed)) {
    // 尝试计算表达式
    const evalResult = evaluateExpression(trimmed, defines);
    if (evalResult !== null) {
      if (evalResult >= 0 && evalResult <= 255) {
        return { valid: true, value: evalResult };
      } else {
        return { valid: false, error: `表达式值 ${evalResult} 超出范围 (0-255)` };
      }
    }
    // 如果表达式包含运算符，即使有未定义的符号，也允许通过
    // 因为这可能是一个合法的位操作表达式，由汇编器处理
    return { valid: true };
  }

  // 直接是数字
  const directNum = parseNumber(trimmed);
  if (directNum !== null) {
    if (directNum >= 0 && directNum <= 255) {
      return { valid: true, value: directNum };
    } else {
      return { valid: false, error: `数值 ${directNum} 超出范围 (0-255)` };
    }
  }

  // 是符号，尝试追踪
  const visited = new Set<string>();
  const resolved = resolveToValue(trimmed, defines, visited);

  if (resolved === null) {
    // 追踪失败，可能是展开后的表达式（如 39+5），尝试计算
    if (/[+\-*/|\(\)\^!]/.test(trimmed)) {
      const evalResult = evaluateExpression(trimmed, defines);
      if (evalResult !== null) {
        if (evalResult >= 0 && evalResult <= 255) {
          return { valid: true, value: evalResult };
        } else {
          return { valid: false, error: `表达式值 ${evalResult} 超出范围 (0-255)` };
        }
      }
    }
    // 检查符号是否在定义中
    if (!defines.has(trimmed.toUpperCase())) {
      return { valid: false, error: `符号 ${trimmed} 未定义` };
    }
    // 追踪失败且无法计算表达式
    return { valid: false, error: `符号 ${trimmed} 无法解析为有效数值（可能循环定义）` };
  }

  if (resolved < 0 || resolved > 255) {
    return { valid: false, error: `符号 ${trimmed} 的值 ${resolved} 超出范围 (0-255)` };
  }

  return { valid: true, value: resolved };
}

// 解析非活动块，返回需要跳过的行号集合
// 支持多种格式: #IF, IF, .IF, #IFDEF, IFDEF, .IFDEF 等
// 预处理指令顺序执行：#define 在 ifndef 之后定义时，ifndef 检测时该符号未定义
function getInactiveLinesNY(content: string): Set<number> {
  const lines = content.split('\n');
  const inactiveLines = new Set<number>();
  const defines = new Set<string>();
  let depth = 0;
  let inactive = false;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过注释行
    if (line.startsWith(';') || line.startsWith('//')) continue;

    // 收集 #DEFINE（在条件判断之前收集，这样才能顺序执行）
    const defineMatch = line.match(/#\s*DEFINE\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    if (defineMatch) {
      defines.add(defineMatch[1].toUpperCase());
    }

    // 匹配预处理指令，支持 #IF / IF / .IF 等多种格式（允许行首空白）
    // #IFDEF xxx 或 IFDEF xxx 或 .IFDEF xxx
    const ifdefMatch = line.match(/^\s*(?:#\s*)?\.?(IFDEF)\s+(\w+)/i);
    if (ifdefMatch) {
      if (!inactive) {
        if (!defines.has(ifdefMatch[2].toUpperCase())) {
          inactive = true;
          blockStart = i;
        }
      } else {
        depth++;
      }
      continue;
    }

    // #IFNDEF xxx 或 IFNDEF xxx 或 .IFNDEF xxx
    const ifndefMatch = line.match(/^\s*(?:#\s*)?\.?(IFNDEF)\s+(\w+)/i);
    if (ifndefMatch) {
      if (!inactive) {
        if (defines.has(ifndefMatch[2].toUpperCase())) {
          inactive = true;
          blockStart = i;
        }
      } else {
        depth++;
      }
      continue;
    }

    // #IF xxx 或 IF xxx 或 .IF xxx
    const ifMatch = line.match(/^\s*(?:#\s*)?\.?(IF)\s+(\S+)/i);
    if (ifMatch) {
      if (!inactive) {
        const val = ifMatch[2];
        // 支持 0/1 数值判断
        if (val === '0') {
          inactive = true;
          blockStart = i;
        } else if (val !== '1') {
          // 非0/1的值视为真（非活动）
        }
      } else {
        depth++;
      }
      continue;
    }

    // #ELSE 或 ELSE 或 .ELSE
    if (/^\s*(?:#\s*)?\.?(ELSE)\b/i.test(line)) {
      if (depth === 0) {
        if (inactive && blockStart >= 0) {
          inactiveLines.add(blockStart);
          for (let j = blockStart + 1; j < i; j++) {
            inactiveLines.add(j);
          }
          inactive = false;
          blockStart = -1;
        } else if (!inactive && blockStart === -1) {
          inactive = true;
          blockStart = i;
        }
      }
      continue;
    }

    // #ELIF xxx 或 ELIF xxx 或 .ELIF xxx
    if (/^\s*(?:#\s*)?\.?(ELIF)\b/i.test(line)) {
      if (depth === 0) {
        if (inactive && blockStart >= 0) {
          inactiveLines.add(blockStart);
          for (let j = blockStart + 1; j < i; j++) {
            inactiveLines.add(j);
          }
          inactive = false;
          blockStart = -1;
        } else if (!inactive && blockStart === -1) {
          inactive = true;
          blockStart = i;
        }
      }
      continue;
    }

    // #ENDIF 或 ENDIF 或 .ENDIF
    if (/^\s*(?:#\s*)?\.?(ENDIF)\b/i.test(line)) {
      if (depth > 0) {
        depth--;
      } else if (inactive && blockStart >= 0) {
        inactiveLines.add(blockStart);
        for (let j = blockStart + 1; j < i; j++) {
          inactiveLines.add(j);
        }
        inactive = false;
        blockStart = -1;
      }
      continue;
    }

    // 普通代码行
    if (inactive && blockStart >= 0) {
      inactiveLines.add(i);
    }
  }

  return inactiveLines;
}

// 收集宏定义内部的行号范围
function getMacroDefinitionLines(content: string): Set<number> {
  const lines = content.split('\n');
  const macroLines = new Set<number>();
  let inMacro = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过注释行
    if (line.startsWith(';') || line.startsWith('//')) continue;

    // 去除注释后检查
    const lineWithoutComment = line.replace(/;.*$/, '').trim();

    // 检查是否是宏定义开始
    if (/^[A-Za-z_][A-Za-z0-9_]*\s+MACRO\b/i.test(lineWithoutComment)) {
      inMacro = true;
    }

    // 如果在宏内，收集行号
    if (inMacro) {
      macroLines.add(i);

      // 检查是否是宏定义结束
      if (/\bENDM\b/i.test(lineWithoutComment)) {
        inMacro = false;
      }
    }
  }

  return macroLines;
}

// 收集 cblock 内部的行号范围
function getCblockDefinitionLines(content: string): Set<number> {
  const lines = content.split('\n');
  const cblockLines = new Set<number>();
  let inCblock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 跳过注释行
    if (line.startsWith(';') || line.startsWith('//')) continue;

    // 去除注释后检查
    const lineWithoutComment = line.replace(/;.*$/, '').trim();

    // 检查是否是 cblock 开始
    if (/^\s*CBLOCK\s+\S+/i.test(lineWithoutComment)) {
      inCblock = true;
    }

    // 如果在 cblock 内，收集行号
    if (inCblock) {
      cblockLines.add(i);

      // 检查是否是 cblock 结束
      if (/^\s*ENDC\b/i.test(lineWithoutComment)) {
        inCblock = false;
      }
    }
  }

  return cblockLines;
}

// 检查成对指令（条件指令、宏定义、cblock）
function checkPairedDirectives(content: string, document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const lines = content.split('\n');
  
  // 条件指令栈
  const condStack: { type: string; line: number }[] = [];
  // 宏定义栈
  const macroStack: { line: number }[] = [];
  // cblock栈
  const cblockStack: { line: number; startNum: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const textWithoutComment = line.replace(/;.*$/, '').replace(/\/\/.*$/, '').trim();
    
    if (!textWithoutComment) continue;

    // 条件指令检查
    const condMatch = textWithoutComment.match(/^\s*(?:#\s*)?\.?(IF|IFDEF|IFNDEF)\b/i);
    if (condMatch) {
      condStack.push({ type: condMatch[1].toUpperCase(), line: i });
    }
    
    if (/^\s*(?:#\s*)?\.?(ENDIF)\b/i.test(textWithoutComment)) {
      if (condStack.length === 0) {
        // 多余的ENDIF
        diagnostics.push({
          range: new vscode.Range(i, 0, i, line.length),
          message: `多余的 ENDIF，没有对应的 IF/IFDEF/IFNDEF`,
          severity: vscode.DiagnosticSeverity.Error
        });
      } else {
        condStack.pop();
      }
    }

    // 宏定义检查
    if (/^[A-Za-z_][A-Za-z0-9_]*\s+MACRO\b/i.test(textWithoutComment)) {
      macroStack.push({ line: i });
    }
    
    if (/\bENDM\b/i.test(textWithoutComment)) {
      if (macroStack.length === 0) {
        // 多余的ENDM
        diagnostics.push({
          range: new vscode.Range(i, 0, i, line.length),
          message: `多余的 ENDM，没有对应的 MACRO`,
          severity: vscode.DiagnosticSeverity.Error
        });
      } else {
        macroStack.pop();
      }
    }

    // cblock检查
    const cblockMatch = textWithoutComment.match(/^\s*CBLOCK\b/i);
    if (cblockMatch) {
      // 检查是否有起始数字
      const startNumMatch = textWithoutComment.match(/^\s*CBLOCK\s+(\S+)/i);
      if (!startNumMatch) {
        // cblock后面没有数字
        diagnostics.push({
          range: new vscode.Range(i, 0, i, line.length),
          message: `CBLOCK 必须指定起始数字 (0-255)`,
          severity: vscode.DiagnosticSeverity.Error
        });
      } else {
        const startNumStr = startNumMatch[1];
        const startNum = parseNumber(startNumStr);
        if (startNum === null || startNum < 0 || startNum > 255) {
          // cblock开始数字错误
          diagnostics.push({
            range: new vscode.Range(i, 0, i, line.length),
            message: `CBLOCK 开始数字必须是 0-255 的有效数值`,
            severity: vscode.DiagnosticSeverity.Error
          });
        }
        cblockStack.push({ line: i, startNum: startNum || 0 });
      }
    }
    
    if (/^\s*ENDC\b/i.test(textWithoutComment)) {
      if (cblockStack.length === 0) {
        // 多余的ENDC
        diagnostics.push({
          range: new vscode.Range(i, 0, i, line.length),
          message: `多余的 ENDC，没有对应的 CBLOCK`,
          severity: vscode.DiagnosticSeverity.Error
        });
      } else {
        cblockStack.pop();
      }
    }
  }

  // 检查未闭合的条件指令
  for (const item of condStack) {
    diagnostics.push({
      range: new vscode.Range(item.line, 0, item.line, lines[item.line].length),
      message: `未闭合的 ${item.type}，缺少对应的 ENDIF`,
      severity: vscode.DiagnosticSeverity.Error
    });
  }

  // 检查未闭合的宏定义
  for (const item of macroStack) {
    diagnostics.push({
      range: new vscode.Range(item.line, 0, item.line, lines[item.line].length),
      message: `未闭合的 MACRO，缺少对应的 ENDM`,
      severity: vscode.DiagnosticSeverity.Error
    });
  }

  // 检查未闭合的cblock
  for (const item of cblockStack) {
    diagnostics.push({
      range: new vscode.Range(item.line, 0, item.line, lines[item.line].length),
      message: `未闭合的 CBLOCK，缺少对应的 ENDC`,
      severity: vscode.DiagnosticSeverity.Error
    });
  }

  return diagnostics;
}

export function checkNYSyntax(document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const docDir = path.dirname(document.uri.fsPath);
  const content = document.getText();
  
  // 检查成对指令
  const pairedDiagnostics = checkPairedDirectives(content, document);
  diagnostics.push(...pairedDiagnostics);
  
  const { labels, defines, macros } = collectSymbols(document, docDir);

  // 获取需要跳过的非活动行（预处理指令顺序执行）
  const inactiveLines = getInactiveLinesNY(content);

  // 获取宏定义内部的行（这些行不进行操作数验证）
  const macroLines = getMacroDefinitionLines(content);
  // 获取 cblock 内部的行（这些行不进行操作数验证）
  const cblockLines = getCblockDefinitionLines(content);

  // 逐行检查
  for (let line = 0; line < document.lineCount; line++) {
    // 跳过非活动块中的行
    if (inactiveLines.has(line)) continue;
    // 跳过宏定义内部的行
    if (macroLines.has(line)) continue;
    // 跳过 cblock 内部的行
    if (cblockLines.has(line)) continue;

    const text = document.lineAt(line).text;
    const trimText = text.trim();

    // 跳过空行和注释行
    if (!trimText || trimText.startsWith(';') || trimText.startsWith('//')) continue;

    // 单独标签行跳过（去除注释后再检查）
    const textWithoutComment = text.replace(/;.*$/, '').replace(/\/\/.*$/, '');
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*:\s*$/.test(textWithoutComment)) continue;

    // 去除注释后分析
    let codePart = text;
    let commentIdx = text.indexOf(';');
    if (commentIdx === -1) commentIdx = text.indexOf('//');
    if (commentIdx !== -1) {
      codePart = text.substring(0, commentIdx).trim();
    }

    if (!codePart) continue;

    // 宏定义行不报错
    const macroInfo = isMacroDefinition(codePart);
    if (macroInfo.isMacro) {
      continue;
    }

    // 展开 #define 宏
    const expandedCode = expandDefines(codePart, defines);
    // 按空格分割
    const tokens = expandedCode.split(/\s+/).filter(t => t.trim() !== '');
    const originalTokens = codePart.split(/\s+/).filter(t => t.trim() !== '');

    if (tokens.length === 0) continue;

    const inst = tokens[0].toUpperCase();
    const instStart = text.indexOf(originalTokens[0]);
    const instEnd = instStart + originalTokens[0].length;

    // 伪指令不报错（包括条件编译指令）
    if (NY_PSEUDO.has(inst) || NY_DEFINE_PSEUDO.has(inst) || NY_CONDITIONAL_PSEUDO.has(inst)) {
      continue;
    }

    // 宏调用不报错
    if (macros.has(inst)) {
      continue;
    }

    // EQU 行不报错
    if (codePart.toUpperCase().includes('EQU')) {
      continue;
    }

    // VARIABLE 行不报错
    if (codePart.toUpperCase().startsWith('VARIABLE')) {
      continue;
    }

    // 指令检查（跳过宏定义内部的行）
    if (!NY_INSTRUCTIONS.has(inst) && !macroLines.has(line)) {
      diagnostics.push({
        range: new vscode.Range(line, instStart, line, instEnd),
        message: `非法指令：${originalTokens[0]}`,
        severity: vscode.DiagnosticSeverity.Error
      });
      continue;
    }

    // 操作数检查（跳过宏定义内部的行）
    const rule = NY_RULES[inst];
    if (rule && !macroLines.has(line)) {
      // 检查操作数数量
      const realParams = tokens.slice(1).filter(t => t.trim() !== '');
      const originalParams = originalTokens.slice(1);

      // 计算实际的操作数数量（处理带逗号的操作数）
      function countOperands(params: string[]): number {
        let count = 0;
        for (const p of params) {
          if (p.includes(',')) {
            count += p.split(',').filter(s => s.trim() !== '').length;
          } else {
            count++;
          }
        }
        return count;
      }

      const actualOperandCount = countOperands(realParams);

      // 无操作数指令
      if (rule.operands === 0 && actualOperandCount > 0) {
        const remaining = expandedCode.substring(tokens[0].length).trim();
        if (!remaining || remaining.startsWith(';') || remaining.startsWith('//')) {
          // 只有注释，允许
        } else {
          // 有多余内容，报错
          diagnostics.push({
            range: new vscode.Range(line, 0, line, text.length),
            message: `${inst} 不需要操作数`,
            severity: vscode.DiagnosticSeverity.Error
          });
        }
        continue;
      }

      // 需要操作数的指令
      if (rule.operands > 0) {
        if (actualOperandCount !== rule.operands) {
          let msg = rule.operands === 2 ? `${inst} 需要2个操作数` : `${inst} 需要1个操作数`;
          diagnostics.push({
            range: new vscode.Range(line, 0, line, text.length),
            message: msg,
            severity: vscode.DiagnosticSeverity.Error
          });
          continue;
        }

        // 验证操作数是否为有效的 0-255 数值
        // NY: 处理不同类型指令的操作数验证
        let operandIdx = -1;
        if (NY_IMMEDIATE_INSTRUCTIONS.has(inst)) {
          // 立即数指令验证第一个操作数
          operandIdx = 0;
        } else if (NY_RAM_INSTRUCTIONS.has(inst) && actualOperandCount >= 1) {
          // RAM 地址指令验证第一个操作数
          operandIdx = 0;
        }

        if (operandIdx >= 0) {
          // 先展开操作数中的宏定义
          const rawOperand = originalParams[operandIdx] || realParams[operandIdx];
          const expandedOperand = expandDefines(rawOperand, defines);
          const result = validateOperand(expandedOperand, defines);

          if (!result.valid) {
            // 找到操作数在原始代码中的位置
            const operandRegex = new RegExp(`\\b${expandedOperand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            const match = codePart.match(operandRegex);
            let pos = codePart.indexOf(expandedOperand);
            if (pos === -1) pos = 0;
            const endPos = pos + expandedOperand.length;

            diagnostics.push({
              range: new vscode.Range(line, pos, line, endPos),
              message: `${inst} 操作数错误: ${result.error}`,
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        }
      }
    }

    // GOTO/CALL 标签检查（跳过宏定义内部的行）
    if ((inst === 'GOTO' || inst === 'CALL') && tokens.length >= 2 && !macroLines.has(line)) {
      const target = tokens[1].toUpperCase();
      if (/^\$[+-]\d+$/.test(target)) {
        // 相对跳转
      } else if (!labels.has(target)) {
        const pos = text.indexOf(tokens[1]);
        diagnostics.push({
          range: new vscode.Range(line, pos, line, pos + tokens[1].length),
          message: `标签【${tokens[1]}】未定义`,
          severity: vscode.DiagnosticSeverity.Error
        });
      }
    }
  }

  return diagnostics;
}
