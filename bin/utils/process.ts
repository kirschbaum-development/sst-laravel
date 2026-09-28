import { spawn } from 'child_process';

export const resolveBin = (command: string): string => {
  if (process.platform !== 'win32') {
    return command;
  }

  return command === 'npm' || command === 'npx' ? `${command}.cmd` : command;
};

export const runProcess = (command: string, args: string[], cwd: string) => {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolveBin(command), args, {
      cwd,
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
};
