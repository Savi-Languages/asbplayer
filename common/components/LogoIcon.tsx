import SvgIcon, { SvgIconProps } from '@mui/material/SvgIcon';

// A continuous S: the path from watching to understanding and back again.
const LogoIcon = (props: SvgIconProps) => (
    <SvgIcon viewBox="0 0 32 32" {...props}>
        <rect width="32" height="32" rx="10" fill="#4cc2ff" />
        <path
            d="M23 8H14a4 4 0 0 0 0 8h4a4 4 0 0 1 0 8H9"
            fill="none"
            stroke="#06222e"
            strokeWidth="2.8"
            strokeLinecap="round"
        />
    </SvgIcon>
);
export default LogoIcon;
