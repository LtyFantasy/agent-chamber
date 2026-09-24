import '@testing-library/jest-dom';

/**
 * jsdom 无 Element.prototype.scrollIntoView（实测 undefined），组件里的
 * `el.scrollIntoView?.({ block: 'nearest' })` 调用在无 stub 时会静默跳过。
 *
 * 为什么挂在 **Element** 而不是 HTMLElement：既有用例（docs page.test.tsx 的
 * headingPath 导航两例）是 per-test `Object.defineProperty(HTMLElement.prototype, ...)`
 * + 用例末 `delete` 的写法，delete 删的是 HTMLElement.prototype 上的自有属性槽；
 * 若全局 stub 也放 HTMLElement.prototype，会被 delete 一并铲掉且之后的用例再无法调用。
 * 放 Element 层：delete 后沿原型链自然落回本 stub，既有用例一行不用改。
 */
Element.prototype.scrollIntoView = jest.fn();
