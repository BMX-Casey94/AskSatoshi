/**
 * The Satoshi hero. Both frames are preloaded and stacked; switching is an opacity
 * crossfade with zero layout shift (the container size is fixed). Image 2 is
 * rendered 20% smaller and slightly higher to suit the standing pose.
 * pointer-events: none lets clicks fall through to the composer it overlaps.
 */

interface Props {
  /** True while the user is interacting with the composer (focus / typing). */
  interacting: boolean;
}

export function Hero({ interacting }: Props) {
  return (
    <div className="hero" aria-hidden="true">
      <img
        src="/Satoshi_Hero_Image_1.webp"
        alt=""
        className={`hero-img${interacting ? ' hero-img--hidden' : ''}`}
        draggable={false}
      />
      <img
        src="/Satoshi_Hero_Image_2.webp"
        alt=""
        className={`hero-img hero-img--interact${interacting ? '' : ' hero-img--hidden'}`}
        draggable={false}
      />
    </div>
  );
}
