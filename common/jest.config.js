module.exports = {
    verbose: true,
    transform: {
        // `.tsx` too: this package is mostly components, and the settings UI
        // shipped a section that silently never rendered because nothing here
        // could render one in a test.
        '^.+\\.tsx?$': 'ts-jest',
    },
    testEnvironment: 'jsdom',
};
