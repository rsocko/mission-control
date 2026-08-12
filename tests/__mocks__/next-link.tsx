import React from 'react';

type LinkProps = React.ComponentPropsWithoutRef<'a'>;

export default function Link({ children, href, ...props }: LinkProps) {
  return React.createElement('a', { href, ...props }, children);
}
