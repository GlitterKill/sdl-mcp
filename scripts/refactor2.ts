import { Project, SyntaxKind } from "ts-morph";

const project = new Project();
project.addSourceFileAtPath("scripts/real-world-benchmark.ts");
const sourceFile = project.getSourceFileOrThrow("scripts/real-world-benchmark.ts");

const funcsToAsync = [
    "buildFileSymbolNameMap",
    "buildFileRepresentativeSymbolMap",
    "findSymbolsByName",
    "scoreSymbolCandidate",
    "searchSymbolsByTerms",
    "collectDependencyNames",
    "applyCardContext",
    "runCompletionPass",
    "runSdlStep",
    "runBenchmark"
];

for (const name of funcsToAsync) {
    const fn = sourceFile.getFunction(name);
    if (fn) {
        fn.setIsAsync(true);
        // If it doesn't already have conn, add a local conn variable
        if (name !== "runBenchmark" && name !== "runCompletionPass" && name !== "runSdlStep" && !fn.getVariableStatement("conn")) {
            fn.insertStatements(0, "const conn = await getKuzuConn();");
        }
    }
}

// Ensure runCompletionPass and runSdlStep get conn
for (const name of ["runCompletionPass", "runSdlStep"]) {
    const fn = sourceFile.getFunction(name);
    if (fn && !fn.getVariableStatement("conn")) {
        fn.insertStatements(0, "const conn = await getKuzuConn();");
    }
}

// Add await to function calls where needed
sourceFile.forEachDescendant(node => {
    if (node.getKind() === SyntaxKind.CallExpression) {
        const expr = node.asKindOrThrow(SyntaxKind.CallExpression);
        const text = expr.getExpression().getText();
        if (funcsToAsync.includes(text) || text.startsWith("db.")) {
            // Check if it's already awaited
            const parent = expr.getParent();
            if (parent && parent.getKind() !== SyntaxKind.AwaitExpression) {
                expr.replaceWithText(`await ${expr.getText()}`);
            }
        }
    }
});

sourceFile.saveSync();
