import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface MacroCall {
    line: number;
    start: number;
    end: number;
    name: string;
}

interface XCSyntaxResult {
    diagnostics: vscode.Diagnostic[];
    macroCalls: MacroCall[];
}

// ==============================
// XC8PT8503 指令集
// ==============================
const VALID_INSTRUCTIONS = new Set([
    'ADD', 'AND', 'CLRA', 'CLR', 'INVA', 'INV', 'DA',
    'DECA', 'DEC', 'DJA', 'DJ', 'INCA', 'INC', 'IJA', 'IJ',
    'MOV', 'OR', 'SUB', 'XOR',
    'BTC', 'BTS', 'JBTC', 'JBTS',
    'LCR', 'LCA', 'RCR', 'RCA', 'SWAP', 'SWAPA',
    'CALL', 'DI', 'EI', 'JMP', 'NOP', 'RET', 'RETI', 'RETL',
    'SLEEP', 'CWDT', 'TBRD'
]);

// 伪指令
const VALID_PSEUDO = new Set([
    'MACRO', 'ENDM', 'ORG', 'END', 'EQU', 'DB', 'DW',
    'IF', 'ELSE', 'ENDIF', '.ADJUST_IC',
    'BYTE', 'WORD', '.RAMADR', '.ROMADR',
    '.CHIP', '.WRITER', '.OUTFILE', '.CODE_OPTION'
]);

// #define 类伪指令
const DEFINE_PSEUDO = new Set([
    '#DEFINE', '#INCLUDE', 'INCLUDE',
    '#IF', '#IFDEF', '#IFNDEF', '#ENDIF',
    '#ELSE', '#ELIF'
]);

// 操作数规则
const RULES: { [key: string]: { operands: number } } = {
    'ADD': { operands: 2 },
    'AND': { operands: 2 },
    'CLRA': { operands: 0 },
    'CLR': { operands: 1 },
    'INVA': { operands: 1 },
    'INV': { operands: 1 },
    'DA': { operands: 1 },
    'DECA': { operands: 1 },
    'DEC': { operands: 1 },
    'DJA': { operands: 1 },
    'DJ': { operands: 1 },
    'INCA': { operands: 1 },
    'INC': { operands: 1 },
    'IJA': { operands: 1 },
    'IJ': { operands: 1 },
    'MOV': { operands: 2 },
    'OR': { operands: 2 },
    'SUB': { operands: 2 },
    'XOR': { operands: 2 },
    'BTC': { operands: 2 },
    'BTS': { operands: 2 },
    'JBTC': { operands: 2 },
    'JBTS': { operands: 2 },
    'LCR': { operands: 1 },
    'LCA': { operands: 1 },
    'RCR': { operands: 1 },
    'RCA': { operands: 1 },
    'SWAP': { operands: 1 },
    'SWAPA': { operands: 1 },
    'CALL': { operands: 1 },
    'DI': { operands: 0 },
    'EI': { operands: 0 },
    'JMP': { operands: 1 },
    'NOP': { operands: 0 },
    'RET': { operands: 0 },
    'RETI': { operands: 0 },
    'RETL': { operands: 1 },
    'SLEEP': { operands: 0 },
    'CWDT': { operands: 0 },
    'TBRD': { operands: 1 }
};

// 寄存器
const REGISTERS = new Set(['A', 'R', 'SP', 'PC', 'WDT']);

export function checkXCSyntax(document: vscode.TextDocument): XCSyntaxResult {
    const diagnostics: vscode.Diagnostic[] = [];
    const macroCalls: MacroCall[] = [];
    const macros = new Set<string>();
    const macroLines = new Set<number>();
    const defines = new Map<string, string>();
    const labels = new Set<string>();
    const ramAdrLines = new Set<number>();
    
    const docDir = path.dirname(document.uri.fsPath);
    let inMacro = false;
    let inRamAdrBlock = false;
    let currentRamAddr = 0;

    // 收集宏定义和标签
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        const trimText = text.trim();

        // 跳过空行和注释
        if (!trimText || trimText.startsWith(';') || trimText.startsWith('//')) {
            continue;
        }

        let codePart = text;
        let commentIdx = text.indexOf(';');
        if (commentIdx === -1) commentIdx = text.indexOf('//');
        if (commentIdx !== -1) {
            codePart = text.substring(0, commentIdx).trim();
        } else {
            codePart = text.trim();
        }

        if (!codePart) continue;

        // 宏定义
        const macroMatch = codePart.match(/^(\S+)\s+MACRO/i);
        if (macroMatch) {
            inMacro = true;
            macros.add(macroMatch[1].toUpperCase());
            continue;
        }

        if (codePart.toUpperCase() === 'ENDM') {
            inMacro = false;
            continue;
        }

        if (inMacro) {
            macroLines.add(line);
            continue;
        }

        // #define
        const defineMatch = codePart.match(/#\s*DEFINE\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.+))?/i);
        if (defineMatch) {
            defines.set(defineMatch[1].toUpperCase(), defineMatch[2]?.trim() || '');
            continue;
        }

        // 标签定义
        const labelMatch = codePart.match(/^([A-Za-z_][A-Za-z0-9_]*):/);
        if (labelMatch) {
            labels.add(labelMatch[1].toUpperCase());
            continue;
        }

        // EQU 定义
        const equMatch = codePart.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+EQU\s+(.+)/i);
        if (equMatch) {
            labels.add(equMatch[1].toUpperCase());
            defines.set(equMatch[1].toUpperCase(), equMatch[2].trim());
            continue;
        }

        // .ramadr 块
        const ramAdrMatch = codePart.match(/^\.ramadr\s+(\S+)/i);
        if (ramAdrMatch) {
            inRamAdrBlock = true;
            const addrStr = ramAdrMatch[1];
            let addrValue = parseNumber(addrStr);
            if (addrValue === null) {
                const upperAddr = addrStr.toUpperCase();
                if (defines.has(upperAddr)) {
                    addrValue = parseNumber(defines.get(upperAddr)!);
                }
            }
            currentRamAddr = addrValue !== null ? addrValue : 0;
            ramAdrLines.add(line);
            continue;
        }

        // RAM 块内的变量定义
        if (inRamAdrBlock) {
            const byteMatch = codePart.match(/^\s*byte\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?/i);
            if (byteMatch) {
                const varName = byteMatch[1].toUpperCase();
                const arraySize = byteMatch[2] ? parseInt(byteMatch[2], 10) : 1;
                labels.add(varName);
                defines.set(varName, `0x${currentRamAddr.toString(16)}`);
                currentRamAddr += arraySize;
                ramAdrLines.add(line);
                continue;
            }

            const wordMatch = codePart.match(/^\s*word\s+([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?/i);
            if (wordMatch) {
                const varName = wordMatch[1].toUpperCase();
                const arraySize = wordMatch[2] ? parseInt(wordMatch[2], 10) : 1;
                labels.add(varName);
                defines.set(varName, `0x${currentRamAddr.toString(16)}`);
                currentRamAddr += arraySize * 2;
                ramAdrLines.add(line);
                continue;
            }

            if (!codePart.startsWith('byte') && !codePart.startsWith('word')) {
                inRamAdrBlock = false;
            }
        }
    }

    // 语法检查
    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        const trimText = text.trim();

        if (!trimText || trimText.startsWith(';') || trimText.startsWith('//')) {
            continue;
        }

        let codePart = text;
        let commentIdx = text.indexOf(';');
        if (commentIdx === -1) commentIdx = text.indexOf('//');
        if (commentIdx !== -1) {
            codePart = text.substring(0, commentIdx).trim();
        } else {
            codePart = text.trim();
        }

        if (!codePart) continue;

        // 展开宏定义
        let expandedCode = codePart;
        defines.forEach((value, key) => {
            expandedCode = expandedCode.replace(new RegExp(`\\b${key}\\b`, 'gi'), value);
        });

        const tokens = expandedCode.split(/\s+/).filter(t => t.trim() !== '');
        const originalTokens = codePart.split(/\s+/).filter(t => t.trim() !== '');

        if (tokens.length === 0) continue;

        const inst = tokens[0].toUpperCase();
        const originalInst = originalTokens[0].toUpperCase();
        const instStart = text.indexOf(originalTokens[0]);
        const instEnd = instStart + originalTokens[0].length;

        // 伪指令不报错
        if (VALID_PSEUDO.has(originalInst) || DEFINE_PSEUDO.has(originalInst)) {
            continue;
        }

        // 宏调用不报错，但记录宏调用位置
        if (macros.has(inst)) {
            macroCalls.push({ line, start: instStart, end: instEnd, name: inst });
            continue;
        }

        // EQU 行不报错
        if (codePart.toUpperCase().includes('EQU')) {
            continue;
        }

        // 指令检查
        if (!VALID_INSTRUCTIONS.has(originalInst) && !macroLines.has(line) && !ramAdrLines.has(line)) {
            diagnostics.push({
                range: new vscode.Range(line, instStart, line, instEnd),
                message: `非法指令：${originalTokens[0]}`,
                severity: vscode.DiagnosticSeverity.Error
            });
            continue;
        }

        // 操作数检查
        const rule = RULES[inst];
        if (rule && !macroLines.has(line) && !ramAdrLines.has(line)) {
            const realParams = tokens.slice(1).filter(t => t.trim() !== '');
            
            if (realParams.length !== rule.operands) {
                diagnostics.push({
                    range: new vscode.Range(line, instStart, line, text.length),
                    message: `${originalTokens[0]} 需要 ${rule.operands} 个操作数`,
                    severity: vscode.DiagnosticSeverity.Error
                });
            }
        }
    }

    return { diagnostics, macroCalls };
}

function parseNumber(str: string): number | null {
    str = str.trim().toUpperCase();
    if (str.startsWith('0X')) {
        return parseInt(str.substring(2), 16);
    } else if (str.startsWith('$')) {
        return parseInt(str.substring(1), 16);
    } else if (str.startsWith('0B')) {
        return parseInt(str.substring(2), 2);
    } else if (/^\d+$/.test(str)) {
        return parseInt(str, 10);
    }
    return null;
}
