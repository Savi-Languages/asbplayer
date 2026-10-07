import React, { useId } from 'react';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import MuiTextField, { type TextFieldProps } from '@mui/material/TextField';

const SettingsTextField: React.FC<TextFieldProps> = ({ label, id, ...rest }) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    return (
        <FormControl fullWidth>
            <FormLabel htmlFor={inputId} sx={{ mb: 0.75, fontSize: 13 }}>
                {label}
            </FormLabel>
            <MuiTextField id={inputId} {...rest} />
        </FormControl>
    );
};

export default SettingsTextField;
