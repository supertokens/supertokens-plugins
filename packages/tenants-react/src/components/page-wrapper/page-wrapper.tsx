import { ReactNode } from 'react';
import './page-wrapper.css';

export const PageWrapper = ({ children, style }: { children: ReactNode; style?: React.CSSProperties }) => {
  return (
    <div className={'page-wrapper'} style={style}>
      {children}
    </div>
  );
};
