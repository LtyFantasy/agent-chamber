import { render } from '@testing-library/react';
import { Loading } from './loading';

describe('Loading', () => {
  it('renders loading component', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('applies default size classes', () => {
    const { container } = render(<Loading />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-8', 'w-8');
  });

  it('applies small size classes', () => {
    const { container } = render(<Loading size="sm" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-4', 'w-4');
  });

  it('applies large size classes', () => {
    const { container } = render(<Loading size="lg" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-12', 'w-12');
  });

  it('applies custom className', () => {
    const { container } = render(<Loading className="custom-class" />);
    const wrapper = container.querySelector('div');
    expect(wrapper).toHaveClass('custom-class');
  });

  it('has animate-spin class', () => {
    const { container } = render(<Loading />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('animate-spin');
  });
});
