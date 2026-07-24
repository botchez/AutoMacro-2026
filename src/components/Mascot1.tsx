import brocolliImage from "@/assets/brocolli.png";

type MascotProps = {
  size?: number;
  className?: string;
};

export function Mascot({ size = 96, className = "" }: MascotProps) {
  return (
    <img
      src={brocolliImage}
      alt="Broccoli mascot"
      width={size}
      height={size}
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        display: "block",
      }}
    />
  );
}
