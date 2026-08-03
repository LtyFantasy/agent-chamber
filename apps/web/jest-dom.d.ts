/**
 * 让 tsc --noEmit 识别 jest-dom 扩展断言（toBeInTheDocument / toHaveClass 等）。
 * 运行时注入由 jest.setup.js 的同名 import 完成，本文件只负责类型侧。
 */
import '@testing-library/jest-dom';
