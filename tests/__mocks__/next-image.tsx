import React from 'react';

type ImageProps = React.ComponentPropsWithoutRef<'img'>;

export default function Image(props: ImageProps) {
  return React.createElement('img', { ...props, src: props.src || '' });
}
