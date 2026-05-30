import * as fs from 'node:fs';

export interface FileToolDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FileToolStats {
  isDirectory(): boolean;
}

export interface FileToolOperations {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stat(path: string): FileToolStats;
  readdir(path: string): FileToolDirent[];
  mkdir(path: string): void;
}

export const localFileToolOperations: FileToolOperations = {
  exists: (path) => fs.existsSync(path),
  readFile: (path) => fs.readFileSync(path, 'utf-8'),
  writeFile: (path, content) => fs.writeFileSync(path, content, 'utf-8'),
  stat: (path) => fs.statSync(path),
  readdir: (path) => fs.readdirSync(path, { withFileTypes: true }),
  mkdir: (path) => fs.mkdirSync(path, { recursive: true }),
};
