# DctMCULang VS Code 插件
## 程序智能化编辑工具 · 语法高亮 + 实时检查 + 编译集成

---

## 🧩 功能特性
✅ 自动识别不同 IC 型号配置头
✅ 指令高亮（鲜艳颜色）
✅ 伪指令浅色显示
✅ 大小写完全兼容
✅ 实时语法错误检查
✅ 支持多种单片机指令集
✅ 可集成对应 IDE 编译

---

## 📌 支持 IC 型号

| IC 型号 | 配置头语法 |
|---------|-----------|
| PDK 系列 | `;//@@@PDK inst###` |
| HXW 系列 | `;//@@@HXW inst###` |
| NY 系列 | `;//@@@NY inst####` |

---

## 📌 PDK 指令集
MOV, ADD, ADDC, NADD, SUB, SUBC, AND, OR, XOR,
NEG, NOT, CLEAR, SET0, SET1, INC, DEC,
SL, SR, SLC, SRC, COMP, SWAP, SWAPC,
GOTO, CEQSN, CENQSN, T0SN, T1SN, IZSN, DZSN,
CALL, RET, RETI, NOP,
PUSHAF, POPAF, LDT16, STT16, IDXM, XCH,
ENGINT, DISGINT, PCADD,
STOPSYS, STOPEXE, RESET, WDRESET

## 📌 HXW 指令集
BCR, BCF, BSR, BSF, BTRSC, BTFSC, BTRSS, BTFSS,
NOP, CLRWDT, SLEEP,
DAA, DAW, DAS,
RETURN, RETFIE,
CLRA, CLRW, CLRR, CLRF,
MOVAR, MOVWF, MOVR, MOVF, MOVIA, MOVLW,
DECR, DECF, DECRSZ, DECFSZ,
INCR, INCF, INCRSZ, INCFSZ,
ADDAR, ADDWF, ADCAR, ADCWF,
SUBAR, SUBWF, SBCAR, SBCWF,
ANDAR, ANDWF, ANDIA, ANDLW,
IORAR, IORWF, IORIA, IORLW,
XORAR, XORWF, XORIA, XORLW,
COMR, COMF,
RLR, RLF, RRR, RRF, SWAPR, SWAPF,
ADDIA, ADDLW, SUBIA, SUBLW,
RETIA, RETLW,
CALL, GOTO

## 📌 NY 指令集
ANDAR, IORAR, XORAR, ANDIA, IORIA, XORIA,
ADDAR, SUBAR, ADCAR, SBCAR, ADDIA, SUBIA, ADCIA, SBCIA,
RRR, RLR, COMR, INCR, DECR, CLRA, CLRR, DAA, CMPAR,
BTRSC, BTRSS, INCRSZ, DECRSZ,
MOVAR, MOVR, MOVIA, IOST, IOSTR, SFUN, SFUNR, T0MD, T0MDR,
NOP, SLEEP, CLRWDT, ENI, DISI, INT,
RET, RETIE, RETIA, CALLA, GOTOA, LCALL, LGOTO, TABLEA,
BSR, BCR, SWAPR

---

## 🚀 使用方法

### 1. 安装插件
- 在 VS Code 中打开扩展面板
- 搜索 `DctMCULang`
- 点击安装

### 2. 创建源文件
新建文件，文件扩展名为 `.asm` 或 `.inc`

### 3. 添加 IC 型号配置头
在文件第一行添加对应 IC 型号的配置头：

**PDK 系列：**
```asm
;//@@@PDK inst###
```

**HXW 系列：**
```asm
;//@@@HXW inst###
```

**NY 系列：**
```asm
;//@@@NY inst####
```

### 4. 开始编写代码
- 插件自动激活
- 编写代码时自动高亮显示
- 语法错误自动显示波浪线提示

---

## 📂 项目结构
DctMCULang/
├── package.json 插件配置
├── README.md 使用说明
├── LICENSE 开源协议
├── syntaxes/ 语法高亮
├── src/ 插件源码
└── out/ 编译输出

---

## 🔨 开发者编译
```bash
npm install
npm run compile
vsce package
```
---
```bash
npm run clean
npm run compile
vsce package
```

## ✉️ 作者
Maxwell
Gitee: https://gitee.com/wflwang
