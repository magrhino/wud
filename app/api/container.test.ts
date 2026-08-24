// @ts-nocheck
jest.mock('express', () => ({
    Router: jest.fn(() => ({
        use: jest.fn(),
        get: jest.fn(),
        post: jest.fn(),
        delete: jest.fn(),
    })),
}));

jest.mock('nocache', () => jest.fn());

jest.mock('../configuration', () => ({
    getLogLevel: jest.fn(() => 'info'),
    getServerConfiguration: jest.fn(() => ({
        feature: {
            delete: true,
        },
    })),
}));

jest.mock('../store/container', () => ({
    getContainer: jest.fn(),
    getContainers: jest.fn(),
    deleteContainer: jest.fn(),
}));

jest.mock('../registry', () => ({
    getState: jest.fn(),
}));

import * as containerRouter from './container';
import * as storeContainer from '../store/container';
import * as registry from '../registry';

function createTrigger(type, name, configuration) {
    return {
        type,
        name,
        maskConfiguration: () => configuration,
    };
}

async function watchContainer(id) {
    const router = containerRouter.init();
    const routeHandler = router.post.mock.calls.find(
        ([route]) => route === '/:id/watch',
    )[1];
    const response = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
    };
    await routeHandler({ params: { id } }, response);
    return response;
}

describe('Container Router', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
    });

    test('getContainerTriggers should not associate opt-in triggers by default', async () => {
        const router = containerRouter.init();
        const routeHandler = router.get.mock.calls.find(
            ([route]) => route === '/:id/triggers',
        )[1];

        storeContainer.getContainer.mockReturnValue({
            id: 'container1',
        });
        registry.getState.mockReturnValue({
            trigger: {
                'smtp.gmail': createTrigger('smtp', 'gmail', {
                    includebydefault: true,
                }),
                'dockercompose.local': createTrigger('dockercompose', 'local', {
                    includebydefault: false,
                }),
            },
        });

        const mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await routeHandler({ params: { id: 'container1' } }, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(200);
        expect(mockRes.json).toHaveBeenCalledWith([
            {
                id: 'smtp.gmail',
                type: 'smtp',
                name: 'gmail',
                configuration: {
                    includebydefault: true,
                },
            },
        ]);
    });

    test('getContainerTriggers should associate explicitly included opt-in triggers', async () => {
        const router = containerRouter.init();
        const routeHandler = router.get.mock.calls.find(
            ([route]) => route === '/:id/triggers',
        )[1];

        storeContainer.getContainer.mockReturnValue({
            id: 'container1',
            triggerInclude: 'dockercompose.local:minor',
        });
        registry.getState.mockReturnValue({
            trigger: {
                'smtp.gmail': createTrigger('smtp', 'gmail', {
                    includebydefault: true,
                }),
                'dockercompose.local': createTrigger('dockercompose', 'local', {
                    includebydefault: false,
                }),
            },
        });

        const mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };

        await routeHandler({ params: { id: 'container1' } }, mockRes);

        expect(mockRes.status).toHaveBeenCalledWith(200);
        expect(mockRes.json).toHaveBeenCalledWith([
            {
                id: 'dockercompose.local',
                type: 'dockercompose',
                name: 'local',
                configuration: {
                    includebydefault: false,
                    threshold: 'minor',
                },
            },
        ]);
    });

    test('watchContainer should replace a stale id without deleting unrelated containers', async () => {
        const staleContainer = {
            id: 'stale-id',
            name: 'app',
            watcher: 'local',
        };
        const currentContainer = {
            id: 'current-id',
            name: 'app',
            watcher: 'local',
        };
        const unrelatedContainer = {
            id: 'unrelated-id',
            name: 'other',
            watcher: 'local',
        };
        const watcher = {
            getContainers: jest
                .fn()
                .mockResolvedValue([currentContainer, unrelatedContainer]),
            watchContainer: jest.fn().mockResolvedValue({
                container: currentContainer,
            }),
        };
        storeContainer.getContainer.mockReturnValue(staleContainer);
        registry.getState.mockReturnValue({
            watcher: { 'docker.local': watcher },
        });
        const mockRes = await watchContainer('stale-id');

        expect(watcher.getContainers).toHaveBeenCalledWith(false);
        expect(watcher.watchContainer).toHaveBeenCalledWith(
            currentContainer,
            false,
            'stale-id',
        );
        expect(storeContainer.deleteContainer).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(200);
        expect(mockRes.json).toHaveBeenCalledWith(currentContainer);
    });

    test('watchContainer should preserve the store when discovery fails', async () => {
        const watcher = {
            getContainers: jest
                .fn()
                .mockRejectedValue(new Error('Docker unavailable')),
            watchContainer: jest.fn(),
        };
        storeContainer.getContainer.mockReturnValue({
            id: 'stale-id',
            name: 'app',
            watcher: 'local',
        });
        registry.getState.mockReturnValue({
            watcher: { 'docker.local': watcher },
        });
        const mockRes = await watchContainer('stale-id');

        expect(watcher.watchContainer).not.toHaveBeenCalled();
        expect(storeContainer.deleteContainer).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(500);
    });

    test('watchContainer should preserve the stale container when its replacement reports an error', async () => {
        const currentContainer = {
            id: 'current-id',
            name: 'app',
            watcher: 'local',
        };
        const failedContainer = {
            ...currentContainer,
            error: { message: 'Registry unavailable' },
        };
        const watcher = {
            getContainers: jest.fn().mockResolvedValue([currentContainer]),
            watchContainer: jest.fn().mockResolvedValue({
                container: failedContainer,
            }),
        };
        storeContainer.getContainer.mockReturnValue({
            id: 'stale-id',
            name: 'app',
            watcher: 'local',
        });
        registry.getState.mockReturnValue({
            watcher: { 'docker.local': watcher },
        });
        const mockRes = await watchContainer('stale-id');

        expect(watcher.watchContainer).toHaveBeenCalledWith(
            currentContainer,
            false,
            'stale-id',
        );
        expect(storeContainer.deleteContainer).not.toHaveBeenCalled();
        expect(mockRes.status).toHaveBeenCalledWith(200);
        expect(mockRes.json).toHaveBeenCalledWith(failedContainer);
    });
});
