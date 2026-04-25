import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
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

// 递归收集所有文件中的 #DEFINE 指令
// excludeFile: 要排除的文件（通常是当前文件）
function collectDefinesFromFile(filePath: string, visited: Set<string>, excludeFile?: string): Set<string> {
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
    const includeDefines = collectDefinesFromFile(incPath, visited, excludeFile);
    includeDefines.forEach(d => defines.add(d));
  }
  
  // 处理当前文件中的 #DEFINE，考虑条件编译
  // 如果是排除的文件，跳过
  if (filePath !== excludeFile) {
    let depth = 0;
    let active = true;
    const stack: boolean[] = [];
    
    for (const line of lines) {
      const trimLine = line.trim();
      if (trimLine.startsWith(';') || trimLine.startsWith('//')) continue;
      
      // 处理条件编译指令
      if (active) {
        // #IFDEF xxx
        const ifdefMatch = trimLine.match(/^(?:#\s*)?\.?(IFDEF)\s+(\w+)/i);
        if (ifdefMatch) {
          const defineName = ifdefMatch[2].toUpperCase();
          const isDefined = defines.has(defineName);
          stack.push(active);
          active = isDefined;
          depth++;
          continue;
        }
        
        // #IFNDEF xxx
        const ifndefMatch = trimLine.match(/^(?:#\s*)?\.?(IFNDEF)\s+(\w+)/i);
        if (ifndefMatch) {
          const defineName = ifndefMatch[2].toUpperCase();
          const isDefined = defines.has(defineName);
          stack.push(active);
          active = !isDefined;
          depth++;
          continue;
        }
        
        // #IF xxx
        const ifMatch = trimLine.match(/^(?:#\s*)?\.?(IF)\s+(\S+)/i);
        if (ifMatch) {
          const val = ifMatch[2];
          stack.push(active);
          active = val !== '0';
          depth++;
          continue;
        }
      }
      
      // #ELSE
      if (/^(?:#\s*)?\.?(ELSE)\b/i.test(trimLine)) {
        if (depth > 0) {
          active = !active;
        }
        continue;
      }
      
      // #ELIF xxx
      if (/^(?:#\s*)?\.?(ELIF)\b/i.test(trimLine)) {
        if (depth > 0) {
          active = !active;
        }
        continue;
      }
      
      // #ENDIF
      if (/^(?:#\s*)?\.?(ENDIF)\b/i.test(trimLine)) {
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
  }
  
  return defines;
}

// 解析预处理器块，返回非活动的行范围
// 支持多种格式: #IF, IF, .IF, #IFDEF, IFDEF, .IFDEF 等
// 预处理指令顺序执行：#define 在 ifndef 之后定义时，ifndef 检测时该符号未定义
function parsePreprocessorBlocks(content: string, filePath: string): vscode.Range[] {
  const lines = content.split('\n');
  const inactiveRanges: vscode.Range[] = [];
  const defines = new Set<string>();
  let depth = 0;
  let inactive = false;
  let blockStart = -1;

  // 收集 include 文件中的 defines（只收集 include 文件中的，不包括当前文件中的）
  if (filePath) {
    const visited = new Set<string>();
    const includeDefines = collectDefinesFromFile(filePath, visited, filePath);
    includeDefines.forEach(d => defines.add(d));
  }

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
          blockStart = i + 1; // 从下一行开始标记为非活动
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
          blockStart = i + 1; // 从下一行开始标记为非活动
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
          blockStart = i + 1; // 从下一行开始标记为非活动
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
          inactiveRanges.push(new vscode.Range(blockStart, 0, i, 0)); // 到当前行开始标记为非活动
          inactive = false;
          blockStart = -1;
        } else if (!inactive && blockStart === -1) {
          inactive = true;
          blockStart = i + 1; // 从下一行开始标记为非活动
        }
      }
      continue;
    }

    // #ELIF xxx 或 ELIF xxx 或 .ELIF xxx
    if (/^\s*(?:#\s*)?\.?(ELIF)\b/i.test(line)) {
      if (depth === 0) {
        if (inactive && blockStart >= 0) {
          inactiveRanges.push(new vscode.Range(blockStart, 0, i, 0)); // 到当前行开始标记为非活动
          inactive = false;
          blockStart = -1;
        } else if (!inactive && blockStart === -1) {
          inactive = true;
          blockStart = i + 1; // 从下一行开始标记为非活动
        }
      }
      continue;
    }

    // #ENDIF 或 ENDIF 或 .ENDIF
    if (/^\s*(?:#\s*)?\.?(ENDIF)\b/i.test(line)) {
      if (depth > 0) {
        depth--;
      } else if (inactive && blockStart >= 0) {
        inactiveRanges.push(new vscode.Range(blockStart, 0, i, 0)); // 到当前行开始标记为非活动
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

  const inactiveRanges = parsePreprocessorBlocks(doc.getText(), doc.uri.fsPath);
  editor.setDecorations(inactiveDecorationType, inactiveRanges);
}

// 执行编译命令
function buildProject() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found.');
    return;
  }

  const doc = editor.document;
  const firstLine = doc.lineAt(0).text.trim();
  const filePath = doc.uri.fsPath;
  const fileDir = path.dirname(filePath);
  const fileName = path.basename(filePath, path.extname(filePath));

  // 检测语言类型并设置编译命令
  let langId = '';
  let compileCmd = '';

  if (firstLine === ';//@@@PDK inst###' || firstLine === ';//@@@PAK inst###') {
    langId = 'PDK';
  } else if (firstLine === ';//@@@NY inst###') {
    langId = 'NY';
  } else if (firstLine === ';//@@@HXW inst###') {
    langId = 'HXW';
  } else {
    vscode.window.showErrorMessage('Unsupported language. Please add language header.');
    return;
  }

  // 收集当前文件所在目录下的所有相关文件
  const files = collectRelatedFiles(fileDir, langId);

  // 显示编译信息
  vscode.window.showInformationMessage(`Building ${langId} project...`);
  vscode.window.createOutputChannel(`Build - ${langId}`).show();

  const outputChannel = vscode.window.createOutputChannel(`Build - ${langId}`);
  outputChannel.show();
  outputChannel.appendLine(`=== Building ${langId} Project ===`);
  outputChannel.appendLine(`Main file: ${filePath}`);
  outputChannel.appendLine(`Related files: ${files.length}`);
  outputChannel.appendLine('');

  // 执行编译命令
  const terminal = vscode.window.createTerminal({
    name: `Build ${langId}`,
    cwd: fileDir
  });

  // 根据语言类型构建编译命令
  // 这里使用假设的编译命令，实际需要根据华芯微IDE的具体命令来设置
  // 例如：hxwasm -o output.hex file1.asm file2.asm
  const compileCommand = buildCompileCommand(langId, files, fileDir);

  if (compileCommand) {
    terminal.sendText(compileCommand);
    terminal.show();
  } else {
    vscode.window.showErrorMessage('Compiler not configured. Please set compiler path in settings.');
  }
}

// 收集当前文件所在目录下的所有相关文件
function collectRelatedFiles(dir: string, langId: string): string[] {
  const files: string[] = [];
  const extMap: { [key: string]: string[] } = {
    'PDK': ['.pdk', '.asm', '.inc'],
    'NY': ['.ny', '.asm', '.inc'],
    'HXW': ['.asm', '.inc', '.hxg']
  };

  const extensions = extMap[langId] || ['.asm'];

  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if (extensions.includes(ext)) {
            files.push(fullPath);
          }
        }
      } catch {
        // 忽略无法访问的文件
      }
    }
  } catch {
    // 忽略无法读取的目录
  }

  return files;
}

// 构建编译命令
function buildCompileCommand(langId: string, files: string[], fileDir: string): string {
  const outputChannel = vscode.window.createOutputChannel(`Build - ${langId}`);
  outputChannel.show();

  const ideBasePath = getIDEBasPath();
  if (!ideBasePath) {
    outputChannel.appendLine('Error: IDE path not found');
    return '';
  }
  outputChannel.appendLine(`IDE Path: ${ideBasePath}`);

  const gmaPath = path.join(ideBasePath, 'Bin', 'Build', 'gma.exe');
  const slinkPath = path.join(ideBasePath, 'Bin', 'Build', 'slink.exe');

  if (!fs.existsSync(gmaPath)) {
    outputChannel.appendLine(`Error: Assembler not found at ${gmaPath}`);
    vscode.window.showErrorMessage(`汇编器未找到: ${gmaPath}`);
    return '';
  }
  if (!fs.existsSync(slinkPath)) {
    outputChannel.appendLine(`Error: Linker not found at ${slinkPath}`);
    vscode.window.showErrorMessage(`链接器未找到: ${slinkPath}`);
    return '';
  }
  outputChannel.appendLine(`Assembler: ${gmaPath}`);
  outputChannel.appendLine(`Linker: ${slinkPath}`);

  const iniFile = findChipIniFile(fileDir, ideBasePath);
  if (!iniFile) {
    outputChannel.appendLine('Error: Chip configuration file (.ini) not found');
    vscode.window.showErrorMessage('芯片配置文件(.ini)未找到。请在项目目录或IDE目录中放置INI文件。');
    return '';
  }
  outputChannel.appendLine(`Chip Config: ${iniFile}`);
  outputChannel.appendLine('');

  const outputName = path.basename(fileDir);
  const objDir = path.join(fileDir, 'Obj');
  const outputFile = path.join(objDir, `${outputName}.out`);

  if (!fs.existsSync(objDir)) {
    try {
      fs.mkdirSync(objDir, { recursive: true });
      outputChannel.appendLine(`Created directory: ${objDir}`);
    } catch (e) {
      outputChannel.appendLine(`Error: Cannot create Obj directory - ${e}`);
      vscode.window.showErrorMessage('无法创建 Obj 目录。');
      return '';
    }
  }

  const asmFiles = files.filter(f => f.toLowerCase().endsWith('.asm'));
  if (asmFiles.length === 0) {
    outputChannel.appendLine('Error: No assembly files found to compile');
    vscode.window.showErrorMessage('未找到要编译的汇编文件(.asm)。');
    return '';
  }

  outputChannel.appendLine(`Found ${asmFiles.length} assembly file(s):`);
  for (const f of asmFiles) {
    outputChannel.appendLine(`  - ${path.basename(f)}`);
  }
  outputChannel.appendLine('');

  let assembleCommands = '';
  for (const asmFile of asmFiles) {
    const objFile = path.join(objDir, path.basename(asmFile, '.asm') + '.obj');
    assembleCommands += `"${gmaPath}" /INI:"${iniFile}" /OutputPath:"${objDir}" "${asmFile}"\n`;
  }

  const linkCommand = `"${slinkPath}" /INI:"${iniFile}" /OUTPUTFILE:"${outputFile}" /MAP /LINKFILE:"${path.join(objDir, 'link.txt')}"`;

  // 添加 ROM 转换命令
  const rcvPath = path.join(ideBasePath, 'Bin', 'Build', 'RcvSN8.exe');
  const hexFile = path.join(objDir, `${outputName}.hex`);
  
  let rcvCommand = '';
  if (fs.existsSync(rcvPath)) {
    rcvCommand = `"${rcvPath}" /INI:"${iniFile}" /OUTPUTFILE:"${hexFile}" "${outputFile}"`;
  } else {
    const rcvExePath = path.join(ideBasePath, 'Bin', 'Build', 'Rcv.exe');
    if (fs.existsSync(rcvExePath)) {
      rcvCommand = `"${rcvExePath}" /INI:"${iniFile}" /OUTPUTFILE:"${hexFile}" "${outputFile}"`;
    }
  }

  outputChannel.appendLine('=== Build Commands ===');
  outputChannel.appendLine(assembleCommands);
  outputChannel.appendLine(linkCommand);
  if (rcvCommand) {
    outputChannel.appendLine(rcvCommand);
  }
  outputChannel.appendLine('');

  let fullCommand = assembleCommands;
  fullCommand += linkCommand + '\n';
  if (rcvCommand) {
    fullCommand += rcvCommand + '\n';
  }
  return fullCommand;
}

// 获取IDE基础路径
function getIDEBasPath(): string | null {
  const config = vscode.workspace.getConfiguration('dctmculang');
  const idePath = config.get<string>('idePath');

  if (idePath && fs.existsSync(idePath)) {
    return idePath;
  }

  const defaultPaths = [
    'E:\\IC\\HXW\\IDE_V2.1.13_20260205\\IDE_V2.1.13_20260205',
    'C:\\Program Files\\HXW\\IDE',
    'C:\\HXW\\IDE'
  ];

  for (const defaultPath of defaultPaths) {
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }
  }

  vscode.window.showErrorMessage('华芯微IDE路径未找到。请在设置中配置 "dctmculang.idePath"');
  return null;
}

// 查找芯片INI文件
function findChipIniFile(fileDir: string, ideBasePath: string): string | null {
  const iniFiles = [
    path.join(fileDir, 'chip.ini'),
    path.join(fileDir, 'project.ini'),
    path.join(fileDir, 'device.ini'),
    path.join(fileDir, 'SN8P2700A.ini')
  ];

  for (const ini of iniFiles) {
    if (fs.existsSync(ini)) {
      return ini;
    }
  }

  const buildIniDir = path.join(ideBasePath, 'Bin', 'Build');
  if (fs.existsSync(buildIniDir)) {
    try {
      const entries = fs.readdirSync(buildIniDir);
      const defaultIni = entries.find(e => e.match(/^SN8P\d+\.ini$/i));
      if (defaultIni) {
        return path.join(buildIniDir, defaultIni);
      }
      const fallbackIni = path.join(buildIniDir, 'SN8P2700A.ini');
      if (fs.existsSync(fallbackIni)) {
        return fallbackIni;
      }
    } catch {
    }
  }

  return null;
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

  // 注册 build 命令
  const buildCommand = vscode.commands.registerCommand('dctmculang.build', buildProject);
  context.subscriptions.push(buildCommand);

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
