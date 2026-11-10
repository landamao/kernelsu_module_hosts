// Minimal adapter for the official kernelsu 3.3.0 exec bridge.
// API verified against tiann/KernelSU commit 02ffbd447eb6a2f05d9f46e17b1e1c3bcfdd9971.
// No remote scripts, dynamic evaluation, or shell interpolation here.
let sequence = 0;

export function isKernelSU() {
  return typeof window.ksu?.exec === "function";
}

export function exec(command) {
  if (!isKernelSU()) return Promise.reject(new Error("请在 KernelSU 管理器中打开此模块的 WebUI"));
  return new Promise((resolve, reject) => {
    const callback = `__hosts_studio_${Date.now()}_${++sequence}`;
    let expired = false;
    const timer = setTimeout(() => {
      // A bridge timeout does not cancel a root operation. Keep a harmless late callback.
      expired = true;
      window[callback] = () => { delete window[callback]; };
      reject(new Error("操作响应超时，执行结果未知。请重新读取确认，不要重复点击保存。"));
    }, 30000);
    window[callback] = (errno, stdout, stderr) => {
      clearTimeout(timer);
      delete window[callback];
      if (!expired) resolve({ errno: Number(errno), stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    };
    try {
      window.ksu.exec(command, JSON.stringify({}), callback);
    } catch (error) {
      clearTimeout(timer);
      delete window[callback];
      reject(error);
    }
  });
}
