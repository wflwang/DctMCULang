import { createConnection, ProposedFeatures, InitializeParams, InitializeResult } from 'vscode-languageserver/node';

// 创建连接
const connection = createConnection(ProposedFeatures.all);

// 初始化
connection.onInitialize((_params: InitializeParams): InitializeResult => {
    return {
        capabilities: {}
    };
});

// 启动
connection.listen();
