import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import React from 'react';

interface Props {
    children: React.ReactNode[];
    groupLabels: string[];
    selectedGroupIndex: number;
    onGroupSelected: (groupIndex: number) => void;
}

const SettingsGroups: React.FC<Props> = ({ children, groupLabels, selectedGroupIndex, onGroupSelected }) => {
    return (
        <div>
            <Box
                sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 0.75,
                    p: 0.75,
                    bgcolor: 'action.hover',
                    borderRadius: 2,
                    mb: 1,
                }}
            >
                {groupLabels.map((label, index) => {
                    return (
                        <Button
                            key={index}
                            onClick={() => onGroupSelected(index)}
                            aria-pressed={selectedGroupIndex === index}
                            variant={selectedGroupIndex === index ? 'contained' : 'text'}
                            sx={{
                                flex: 1,
                                minWidth: 'fit-content',
                            }}
                        >
                            {label}
                        </Button>
                    );
                })}
            </Box>
            <Stack
                spacing={1}
                sx={{
                    p: 1.5,
                    border: (theme) => `1px solid ${theme.palette.action.focus}`,
                    borderRadius: 2,
                }}
            >
                {children}
            </Stack>
        </div>
    );
};

export default SettingsGroups;
