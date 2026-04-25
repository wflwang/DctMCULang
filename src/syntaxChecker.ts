import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// ==============================
// PFS122 官方指令集
// ==============================
const VALID_INSTRUCTIONS = new Set([
  'MOV', 'MOVR', 'ADDM',
  'ADD', 'ADDC', 'NADD', 'SUB',
  'SUBC',
  'AND', 'OR', 'XOR', 'NEG', 'NOT', 'CLEAR',
  'SET0', 'SET1', 'INC', 'DEC', 'SL', 'SR',
  'SLC', 'SRC', 'COMP', 'SWAP', 'SWAPC',
  'GOTO', 'CEQSN', 'CENQSN', 'T0SN', 'T1SN',
  'IZSN', 'DZSN', 'CALL', 'RET', 'RETI', 'NOP',
  'PUSHAF', 'POPAF', 'LDT16', 'STT16', 'IDXM', 'XCH',
  'ENGINT', 'PCADD', 'DISGINT', 'STOPSYS', 'STOPEXE',
  'RESET', 'WDRESET'
]);

// 伪指令
const VALID_PSEUDO = new Set([
  'MACRO', 'ENDM', 'ORG', 'END', 'EQU', 'DB', 'DW',
  'IF', 'ELSE', 'ENDIF', '.ADJUST_IC'
]);

// #define 类伪指令
const DEFINE_PSEUDO = new Set([
  '#DEFINE', '#INCLUDE', 'INCLUDE',
  '#IF', '#IFDEF', '#IFNDEF', '#ENDIF',
  '#ELSE', '#ELIF'
]);

// PDK 立即数指令（需要验证第一个操作数）
const PDK_IMMEDIATE_INSTRUCTIONS = new Set([
  'MOVR', 'ADDM', 'SUB', 'ADD', 'ADDC', 'NADD', 'SUBC',
  'AND', 'OR', 'XOR', 'COMP', 'CEQSN', 'CENQSN'
]);

// 操作数规则
const RULES: { [key: string]: { operands: number } } = {
  'MOV': { operands: 2 }, 'MOVR': { operands: 2 },
  'ADD': { operands: 2 }, 'ADDC': { operands: 2 },
  'NADD': { operands: 2 }, 'SUB': { operands: 2 },
  'SUBC': { operands: 2 },
  'AND': { operands: 2 }, 'OR': { operands: 2 }, 'XOR': { operands: 2 },
  'COMP': { operands: 2 }, 'CEQSN': { operands: 2 }, 'CENQSN': { operands: 2 },
  'XCH': { operands: 1 }, 'INC': { operands: 1 }, 'DEC': { operands: 1 },
  'SL': { operands: 1 }, 'SR': { operands: 1 }, 'SLC': { operands: 1 },
  'SRC': { operands: 1 }, 'SWAP': { operands: 1 }, 'SWAPC': { operands: 1 },
  'NEG': { operands: 1 }, 'NOT': { operands: 1 }, 'CLEAR': { operands: 1 },
  'SET0': { operands: 1 }, 'SET1': { operands: 1 }, 'GOTO': { operands: 1 },
  'CALL': { operands: 1 }, 'T0SN': { operands: 1 }, 'T1SN': { operands: 1 },
  'IZSN': { operands: 1 }, 'DZSN': { operands: 1 }, 'LDT16': { operands: 1 },
  'STT16': { operands: 1 }, 'IDXM': { operands: 1 },
  'NOP': { operands: 0 }, 'RET': { operands: 0 }, 'RETI': { operands: 0 },
  'PUSHAF': { operands: 0 }, 'POPAF': { operands: 0 }, 'ENGINT': { operands: 0 },
  'DISGINT': { operands: 0 }, 'STOPSYS': { operands: 0 }, 'STOPEXE': { operands: 0 },
  'RESET': { operands: 0 }, 'WDRESET': { operands: 0 }, 'PCADD': { operands: 0 },
};

// 判断是否为宏定义行
function isMacroDefinition(text: string): { isMacro: boolean; macroName: string } {
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

  for (const line of lines) {
    const trimLine = line.trim();
    if (!trimLine || trimLine.startsWith(';') || trimLine.startsWith('//')) continue;

    // 收集标签行 (LABEL:)
    const labelMatch = trimLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (labelMatch) {
      labels.add(labelMatch[1].toUpperCase());
    }

    // #DEFINE xxx yyy 或 #DEFINE xxx 0x38 或 #DEFINE xxx 格式（xxx后面是注释）
    const defMatch = trimLine.match(/#\s*DEFINE\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.+))?/i);
    if (defMatch) {
      const name = defMatch[1].toUpperCase();
      const value = defMatch[2] ? defMatch[2].trim() : '';
      defines.set(name, value);
    }

    // EQU xxx yyy 格式
    // 先去除尾部注释再匹配
    const lineWithoutComment = trimLine.replace(/;.*$/, '').trim();
    const equMatch = lineWithoutComment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)/i);
    if (equMatch) {
      const name = equMatch[1].toUpperCase();
      const value = equMatch[2].trim();
      labels.add(name);
      defines.set(name, value);
    }

    // MACRO
    const macroInfo = isMacroDefinition(trimLine);
    if (macroInfo.isMacro) {
      macros.add(macroInfo.macroName);
      labels.add(macroInfo.macroName);
    }

    // 收集 include 文件路径
    const includeMatch = trimLine.match(/#include\s+([">])([^">]+)\1/i);
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
  function collectRecursively(filePath: string) {
    const result = collectSymbolsFromFile(filePath, visited);

    // 合并符号
    result.labels.forEach(l => labels.add(l));
    result.defines.forEach((v, k) => defines.set(k, v));
    result.macros.forEach(m => macros.add(m));

    // 递归处理所有 include 文件
    for (const incPath of result.includes) {
      collectRecursively(incPath);
    }
  }

  // 首先收集主文件
  collectRecursively(document.uri.fsPath);

  return { labels, defines, macros };
}

// 解析数字字符串，返回数值或 null
function parseNumber(str: string): number | null {
  const trimmed = str.trim();
  // 十六进制: 0x38, 0xFF
  if (/^0x[0-9A-Fa-f]+$/.test(trimmed)) {
    const val = parseInt(trimmed, 16);
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
    expanded = expanded.replace(/0x([0-9A-Fa-f]+)/g, (_, hex) => parseInt(hex, 16).toString());

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

  // 处理带逗号的操作数格式（如 porta,3、port,5）
  // 只验证第一个部分（寄存器/符号）是否定义，逗号后的位值由汇编器处理
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',');
    const firstPart = parts[0].trim();
    if (firstPart) {
      // 第一个部分是符号，检查是否定义
      if (defines.has(firstPart.toUpperCase())) {
        return { valid: true };
      } else {
        return { valid: false, error: `符号 ${firstPart} 未定义` };
      }
    }
    return { valid: false, error: `操作数格式错误` };
  }

  // 处理带运算符的表达式（如 HeadRAM_ADR+31、EndRAM_ADR-1、val*2+1、port|0x10、0|(0<<1)）
  if (/[\+\-\*\/\|\(\)\^!]/.test(trimmed)) {
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
    // visited 为空说明从未查找到定义（未定义）
    if (visited.size === 0) {
      return { valid: false, error: `符号 ${trimmed} 未定义` };
    } else {
      return { valid: false, error: `符号 ${trimmed} 无法解析为有效数值（可能循环定义或未定义）` };
    }
  }

  if (resolved < 0 || resolved > 255) {
    return { valid: false, error: `符号 ${trimmed} 的值 ${resolved} 超出范围 (0-255)` };
  }

  return { valid: true, value: resolved };
}

// 递归收集所有文件中的 #DEFINE 指令
function collectDefinesFromFile(filePath: string, visited: Set<string>): Set<string> {
  const defines = new Set<string>();
  
  if (!fs.existsSync(filePath) || visited.has(filePath)) {
    return defines;
  }
  visited.add(filePath);
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const dir = path.dirname(filePath);
  
  // 先收集所有 include 文件路径
  const includePaths: string[] = [];
  for (const line of lines) {
    const trimLine = line.trim();
    if (trimLine.startsWith(';') || trimLine.startsWith('//')) continue;
    
    // 收集 include 文件路径
    const includeMatch = trimLine.match(/#include\s+([">])([^">]+)\1/i);
    if (includeMatch) {
      const incPath = path.join(dir, includeMatch[2]);
      includePaths.push(incPath);
    }
  }
  
  // 处理所有 include 文件
  for (const incPath of includePaths) {
    const includeDefines = collectDefinesFromFile(incPath, visited);
    includeDefines.forEach(d => defines.add(d));
  }
  
  // 处理当前文件中的 #DEFINE，考虑条件编译
  let depth = 0;
  let active = true;
  const stack: boolean[] = [];
  
  for (const line of lines) {
    const trimLine = line.trim();
    if (trimLine.startsWith(';') || trimLine.startsWith('//')) continue;
    
    // 处理条件编译指令
    if (active) {
      // #IFDEF xxx
      const ifdefMatch = trimLine.match(/^\s*(?:#\s*)?\.?(IFDEF)\s+(\w+)/i);
      if (ifdefMatch) {
        const defineName = ifdefMatch[2].toUpperCase();
        const isDefined = defines.has(defineName);
        stack.push(active);
        active = isDefined;
        depth++;
        continue;
      }
      
      // #IFNDEF xxx
      const ifndefMatch = trimLine.match(/^\s*(?:#\s*)?\.?(IFNDEF)\s+(\w+)/i);
      if (ifndefMatch) {
        const defineName = ifndefMatch[2].toUpperCase();
        const isDefined = defines.has(defineName);
        stack.push(active);
        active = !isDefined;
        depth++;
        continue;
      }
      
      // #IF xxx
      const ifMatch = trimLine.match(/^\s*(?:#\s*)?\.?(IF)\s+(\S+)/i);
      if (ifMatch) {
        const val = ifMatch[2];
        stack.push(active);
        active = val !== '0';
        depth++;
        continue;
      }
    }
    
    // #ELSE
    if (/^\s*(?:#\s*)?\.?(ELSE)\b/i.test(trimLine)) {
      if (depth > 0) {
        active = !active;
      }
      continue;
    }
    
    // #ELIF xxx
    if (/^\s*(?:#\s*)?\.?(ELIF)\b/i.test(trimLine)) {
      if (depth > 0) {
        active = !active;
      }
      continue;
    }
    
    // #ENDIF
    if (/^\s*(?:#\s*)?\.?(ENDIF)\b/i.test(trimLine)) {
      if (depth > 0) {
        active = stack.pop() || true;
        depth--;
      }
      continue;
    }
    
    // 收集 #DEFINE
    if (active) {
      const defineMatch = trimLine.match(/#\s*DEFINE\s+([A-Za-z_][A-Za-z0-9_]*)/i);
      if (defineMatch) {
        const defineName = defineMatch[1].toUpperCase();
        defines.add(defineName);
      }
    }
  }
  
  return defines;
}

// 解析非活动块，返回需要跳过的行号集合
// 预处理指令顺序执行：#define 在 ifndef 之后定义时，ifndef 检测时该符号未定义
function getInactiveLines(content: string, filePath: string): Set<number> {
  const lines = content.split('\n');
  const inactiveLines = new Set<number>();
  const defines = new Set<string>();
  let depth = 0;
  let inactive = false;
  let blockStart = -1;
  
  // 收集 include 文件中的 defines
  const visited = new Set<string>();
  const includeDefines = collectDefinesFromFile(filePath, visited);
  includeDefines.forEach(d => defines.add(d));
  console.log(`Defines collected: ${Array.from(defines).join(', ')}`);

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
          for (let j = blockStart; j <= i; j++) inactiveLines.add(j);
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
          for (let j = blockStart; j <= i; j++) inactiveLines.add(j);
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
        for (let j = blockStart; j <= i; j++) inactiveLines.add(j);
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

export function checkSyntaxErrors(document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const docDir = path.dirname(document.uri.fsPath);
  const content = document.getText();
  const { labels, defines, macros } = collectSymbols(document, docDir);

  // 获取需要跳过的非活动行（预处理指令顺序执行）
  const inactiveLines = getInactiveLines(content, document.uri.fsPath);

  // 获取宏定义内部的行（这些行不进行操作数验证）
  const macroLines = getMacroDefinitionLines(content);

  // 逐行检查
  for (let line = 0; line < document.lineCount; line++) {
    // 跳过非活动块中的行
    if (inactiveLines.has(line)) continue;

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

    // 伪指令不报错
    if (VALID_PSEUDO.has(inst) || DEFINE_PSEUDO.has(inst)) {
      // #include 文件存在性检查
      if (inst === 'INCLUDE' || inst === '#INCLUDE') {
        const includeMatch = text.match(/#include\s+([">])([^">]+)\1/i);
        if (includeMatch) {
          const fileName = includeMatch[2];
          const quotePos = text.indexOf(includeMatch[1]);
          const endQuotePos = text.lastIndexOf(includeMatch[1]);
          const possiblePaths = [
            vscode.Uri.joinPath(document.uri, '..', fileName).fsPath,
            path.join(docDir, fileName)
          ];
          const exists = possiblePaths.some(p => {
            try { return fs.existsSync(p); } catch { return false; }
          });
          if (!exists) {
            diagnostics.push({
              range: new vscode.Range(line, quotePos, line, endQuotePos + 1),
              message: `找不到包含文件：${includeMatch[1]}${fileName}${includeMatch[1]}`,
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        }
      }
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

    // 指令检查（跳过宏定义内部的行）
    if (!VALID_INSTRUCTIONS.has(inst) && !macroLines.has(line)) {
      diagnostics.push({
        range: new vscode.Range(line, instStart, line, instEnd),
        message: `非法指令：${originalTokens[0]}`,
        severity: vscode.DiagnosticSeverity.Error
      });
      continue;
    }

    // 操作数检查（跳过宏定义内部的行）
    const rule = RULES[inst];
    if (rule && !macroLines.has(line)) {
      // 检查操作数数量
      const realParams = tokens.slice(1).filter(t => t.trim() !== '');
      const originalParams = originalTokens.slice(1);

      // 计算真实的操作数数量（逗号分隔的算多个）
      function countOperands(params: string[]): number {
        let count = 0;
        for (const p of params) {
          if (p.includes(',')) {
            count += p.split(',').length;
          } else {
            count += 1;
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
        // PDK: 双操作数指令验证第二个操作数（如 mov a,temp 验证 temp）
        // HXW: 立即数指令（*IA, *LW）验证第一个操作数，双操作数指令（*AR, *WF）验证第二个操作数
        let operandIdx = -1;
        if (actualOperandCount >= 2) {
          if (PDK_IMMEDIATE_INSTRUCTIONS.has(inst)) {
            operandIdx = 1; // PDK: 验证第二个操作数（立即数）
          } else {
            operandIdx = 1; // HXW: 验证第二个操作数
          }
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
