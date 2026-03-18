const fs = require('fs');
let text = fs.readFileSync('src/components/table-manager-dialog.tsx', 'utf8');

text = text.replace(/<ScrollArea className="flex-1 px-4 py-3">/g, '<div className="flex-1 overflow-auto px-5 py-4 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">');

text = text.replace(/<ScrollArea className="flex-1 px-4 py-4">\n\s*<div className="space-y-4">/g, '<div className="flex-1 overflow-auto px-5 py-5 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-track]:bg-transparent">\n            <div className="space-y-4 max-w-5xl mx-auto">');

text = text.replace(/<\/ScrollArea>/g, '</div>');

fs.writeFileSync('src/components/table-manager-dialog.tsx', text, 'utf8');
console.log('Fixed tags');
