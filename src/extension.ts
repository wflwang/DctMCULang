import * as vscode from 'vscode';
import { checkSyntaxErrors } from './syntaxChecker';
import { checkHXWSyntax } from './HXWsyntaxChecker';
import { checkNYSyntax } from './NYsyntaxChecker';

let diagnosticCollection: vscode.DiagnosticCollection;
let inactiveDecorationType: vscode.TextEditorDecorationType;
let activeEditor: vscode.TextEditor | null = null;

// 防抖优化：用户输入时暂停检查，提高响应速度
let pendingUpdate: NodeJS.Timeout | null = null;
let isUserTyping = false;
const DEBOUNCE_DELAY = 800; // 用户停止输入 800ms 后再检查

// 支持的语言
const SUPPORTED_LANGUAGES = ['dctpdk', 'DctNY', 'DctHXW'];

// 解析预处理器块，返回非活动的行范围
// 支持多种格式: #IF, IF, .IF, #IFDEF, IFDEF, .IFDEF 等
// 预处理指令顺序执行：#define 在 ifndef 之后定义时，ifndef 检测时该符号未定义
function parsePreprocessorBlocks(content: string): vscode.Range[] {
  const lines = content.split('\n');
  const inactiveRanges: vscode.Range[] = [];
  const defines = new Set<string>();
  let depth = 0;
  let inactive = false;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    const line = originalLine.trim();

    // 跳过注释行
    if (line.startsWith(';') || line.startsWith('//')) {
      continue;
    }

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
          inactiveRanges.push(new vscode.Range(blockStart, 0, i, originalLine.length));
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
          inactiveRanges.push(new vscode.Range(blockStart, 0, i, originalLine.length));
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
        inactiveRanges.push(new vscode.Range(blockStart, 0, i, originalLine.length));
        inactive = false;
        blockStart = -1;
      }
      continue;
    }

    // 普通代码行
    if (inactive && blockStart >= 0) {
      inactiveRanges.push(new vscode.Range(i, 0, i, originalLine.length));
    }
  }

  return inactiveRanges;
}

// 更新装饰器
function updateInactiveDecorations(editor: vscode.TextEditor) {
  if (!editor) return;

  const doc = editor.document;
  const first = doc.lineAt(0).text.trim();

  // 检查是否是支持的语言
  let isSupported = false;
  if (first === ';//@@@PDK inst###' || first === ';//@@@PAK inst###' ||
      first === ';//@@@NY inst###' || first === ';//@@@HXW inst###') {
    isSupported = true;
  }

  if (!isSupported) {
    editor.setDecorations(inactiveDecorationType, []);
    return;
  }

  const inactiveRanges = parsePreprocessorBlocks(doc.getText());
  editor.setDecorations(inactiveDecorationType, inactiveRanges);
}

export function activate(context: vscode.ExtensionContext) {
  // 创建诊断集合
  diagnosticCollection = vscode.languages.createDiagnosticCollection('dctpdk-syntax');
  context.subscriptions.push(diagnosticCollection);

  // 创建装饰器
  inactiveDecorationType = vscode.window.createTextEditorDecorationType({
    opacity: '0.4'
  });
  context.subscriptions.push(inactiveDecorationType);

  // 监听文档变化（使用防抖优化性能）
  vscode.workspace.onDidChangeTextDocument(e => {
    isUserTyping = true;
    if (pendingUpdate) {
      clearTimeout(pendingUpdate);
    }
    pendingUpdate = setTimeout(() => {
      isUserTyping = false;
      update(e.document);
      if (activeEditor && e.document === activeEditor.document) {
        updateInactiveDecorations(activeEditor);
      }
    }, DEBOUNCE_DELAY);
  });

  // 监听活动编辑器变化
  vscode.window.onDidChangeActiveTextEditor(e => {
    activeEditor = e || null;
    if (activeEditor) {
      update(activeEditor.document);
      updateInactiveDecorations(activeEditor);
    }
  });

  // 初始化当前编辑器
  if (vscode.window.activeTextEditor) {
    activeEditor = vscode.window.activeTextEditor;
    update(activeEditor.document);
    updateInactiveDecorations(activeEditor);
  }
}

function update(doc: vscode.TextDocument) {
  try {
    const first = doc.lineAt(0).text.trim();
    let langId = '';

    // 精确匹配文件头
    if (first === ';//@@@PDK inst###' || first === ';//@@@PAK inst###') {
      langId = 'dctpdk';
    } else if (first === ';//@@@NY inst###') {
      langId = 'DctNY';
    } else if (first === ';//@@@HXW inst###') {
      langId = 'DctHXW';
    }

    if (!langId) {
      diagnosticCollection.clear();
      return;
    }

    // 设置语言
    if (doc.languageId !== langId) {
      vscode.languages.setTextDocumentLanguage(doc, langId);
    }

    // 根据文件类型启用语法检查
    if (langId === 'dctpdk') {
      const errors = checkSyntaxErrors(doc);
      diagnosticCollection.set(doc.uri, errors);
    } else if (langId === 'DctHXW') {
      const errors = checkHXWSyntax(doc);
      diagnosticCollection.set(doc.uri, errors);
    } else if (langId === 'DctNY') {
      const errors = checkNYSyntax(doc);
      diagnosticCollection.set(doc.uri, errors);
    } else {
      diagnosticCollection.clear();
    }
  } catch (err) {
    console.error('Syntax check error:', err);
  }
}

export function deactivate() {
  diagnosticCollection?.clear();
  diagnosticCollection?.dispose();
  inactiveDecorationType?.dispose();
}
