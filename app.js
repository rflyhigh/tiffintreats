class VerszApp {
    constructor() {
        this.currentTrackInterval = null;
        this.recentTracksInterval = null;
        this.searchDebounceTimeout = null;
        this.dataCache = {
            recentTracks: [],
            topTracks: [],
            topArtists: []
        };
        
        const redirectPath = sessionStorage.getItem('redirect_path');
        if (redirectPath) {
            sessionStorage.removeItem('redirect_path');
            history.replaceState(null, '', redirectPath);
        }
        
        this.setupEventListeners();
        this.checkAuthCallback();
        this.checkExistingSession();
        this.setupSearch();
        this.handleRouting();
    }

    setupEventListeners() {
        document.getElementById('login-btn')?.addEventListener('click', () => this.login());
        document.getElementById('logout-btn')?.addEventListener('click', () => this.logout());
        window.addEventListener('popstate', () => this.handleRouting());
        
        document.querySelectorAll('form').forEach(form => 
            form.addEventListener('submit', (e) => e.preventDefault())
        );

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#search-container')) {
                this.hideSearchResults();
            }
        });

        // Add tab switching functionality
        const tabs = document.querySelectorAll('.tab-button');
        tabs.forEach(tab => {
            tab.addEventListener('click', (e) => {
                const targetId = e.target.dataset.target;
                this.switchTab(targetId);
            });
        });

        document.querySelectorAll('.error-message').forEach(error => {
            error.addEventListener('click', () => error.classList.add('hidden'));
        });
    }

    switchTab(targetId) {
        // Hide all tab contents
        document.querySelectorAll('.tab-content').forEach(content => {
            content.classList.add('hidden');
        });
        
        // Deactivate all tab buttons
        document.querySelectorAll('.tab-button').forEach(button => {
            button.classList.remove('active');
        });
        
        // Show selected tab content and activate button
        document.getElementById(targetId)?.classList.remove('hidden');
        document.querySelector(`[data-target="${targetId}"]`)?.classList.add('active');
    }

    setupSearch() {
        const searchInput = document.getElementById('user-search');
        const searchResults = document.getElementById('search-results');

        if (!searchInput || !searchResults) return;

        searchInput.addEventListener('input', (e) => {
            clearTimeout(this.searchDebounceTimeout);
            const query = e.target.value.trim();

            if (query.length < 2) {
                this.hideSearchResults();
                return;
            }

            this.searchDebounceTimeout = setTimeout(() => this.performSearch(query), 300);
        });

        searchInput.addEventListener('focus', (e) => {
            if (e.target.value.trim().length >= 2) {
                searchResults.classList.remove('hidden');
            }
        });

        searchResults.addEventListener('click', (e) => {
            const userItem = e.target.closest('.search-result-item');
            if (userItem) {
                const userId = userItem.dataset.userid;
                this.navigateToProfile(userId);
                this.hideSearchResults();
                searchInput.value = '';
                searchInput.blur();
            }
        });
    }

    hideSearchResults() {
        document.getElementById('search-results')?.classList.add('hidden');
    }

    async performSearch(query) {
        const searchResults = document.getElementById('search-results');
        if (!searchResults) return;
    
        try {
            if (!query.trim()) {
                this.hideSearchResults();
                return;
            }
    
            const response = await fetch(`${config.backendUrl}/users/search?query=${encodeURIComponent(query.trim())}`);
            if (!response.ok) throw new Error(`Search failed: ${response.status}`);
            
            const users = await response.json();
            
            searchResults.classList.remove('hidden');
            
            if (users.length === 0) {
                searchResults.innerHTML = `
                    <div class="search-result-item">
                        <div class="placeholder-text">No users found</div>
                    </div>
                `;
            } else {
                searchResults.innerHTML = users.map(user => `
                    <div class="search-result-item" data-userid="${user.id}">
                        <img src="${user.avatar_url || '/api/placeholder/32/32'}" 
                             alt="Avatar" 
                             class="search-avatar"
                             onerror="this.src='/api/placeholder/32/32'">
                        <div class="search-user-info">
                            <div class="search-username">${this.escapeHtml(user.display_name || user.id)}</div>
                        </div>
                    </div>
                `).join('');
            }
        } catch (error) {
            console.error('Search failed:', error);
            searchResults.innerHTML = `
                <div class="search-result-item">
                    <div class="placeholder-text">Search failed. Please try again.</div>
                </div>
            `;
            searchResults.classList.remove('hidden');
        }
    }
    
    escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

   
    login() {
        localStorage.clear();

        const state = Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        
        localStorage.setItem('spotify_auth_state', state);
        localStorage.setItem('login_pending', 'true');
        
        const redirectUri = `${window.location.origin}/callback.html`;
        const authUrl = new URL('https://accounts.spotify.com/authorize');
        
        const params = {
            client_id: config.clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            state: state,
            scope: config.scopes,
            show_dialog: true 
        };
        
        authUrl.search = new URLSearchParams(params).toString();
        window.location.href = authUrl.toString();
    }

    logout() {
        localStorage.removeItem('spotify_user_id');
        localStorage.removeItem('login_pending');
        localStorage.removeItem('spotify_auth_state');
        this.clearIntervals();
        window.location.href = '/';
    }

    clearIntervals() {
        if (this.currentTrackInterval) {
            clearInterval(this.currentTrackInterval);
            this.currentTrackInterval = null;
        }
        if (this.recentTracksInterval) {
            clearInterval(this.recentTracksInterval);
            this.recentTracksInterval = null;
        }
    }

    async checkAuthCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');
        const storedState = localStorage.getItem('spotify_auth_state');
        const error = urlParams.get('error');
    
    
        localStorage.removeItem('spotify_auth_state');
    
        if (error) {
            console.error('Spotify auth error:', error);
            this.showError(`Authentication failed: ${error}`);
            this.logout();
            return;
        }
    
        if (!code) return;
    
        if (!state || !storedState || state !== storedState) {
            console.error('State mismatch:', { received: state, stored: storedState });
            this.showError('Authentication failed: State verification failed');
            this.logout();
            return;
        }
    
        try {
            const response = await fetch(`${config.backendUrl}/auth/callback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: code,
                    redirect_uri: `${window.location.origin}/callback.html`
                })
            });
    
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || 'Authentication failed');
            }
    
            const data = await response.json();
            
            if (!data.user_id) {
                throw new Error('No user ID received from server');
            }
    
            localStorage.setItem('spotify_user_id', data.user_id);
            localStorage.removeItem('login_pending');
            window.location.href = '/';
        } catch (error) {
            console.error('Authentication error:', error);
            this.showError(error.message || 'Authentication failed. Please try again.');
            this.logout();
        }
    }

    async checkExistingSession() {
        const userId = localStorage.getItem('spotify_user_id');
        const loginPending = localStorage.getItem('login_pending');

        if (!userId || loginPending) {
            this.showLoginSection();
            return;
        }

        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}`);
            if (response.ok) {
                await this.handleRouting();
                return;
            }
            throw new Error('Session invalid');
        } catch (error) {
            console.error('Session check failed:', error);
            this.logout();
        }
    }

    navigateToProfile(userId) {
        const newPath = `/${userId}`;
        if (window.location.pathname !== newPath) {
            history.pushState({}, '', newPath);
            this.handleRouting();
        }
    }

    async handleRouting() {
        const path = window.location.pathname;
        const viewingUserId = path === '/' 
            ? localStorage.getItem('spotify_user_id')
            : path.split('/').filter(Boolean)[0];
        
        if (!viewingUserId) {
            this.showLoginSection();
            return;
        }

        try {
            const response = await fetch(`${config.backendUrl}/users/${viewingUserId}`);
            if (!response.ok) throw new Error('User not found');
            
            const userData = await response.json();
            const isOwnProfile = viewingUserId === localStorage.getItem('spotify_user_id');
            await this.showProfileSection(userData, isOwnProfile);
        } catch (error) {
            console.error('Failed to load profile:', error);
            this.showError('Failed to load profile. Please try again later.');
            if (!localStorage.getItem('spotify_user_id')) {
                window.location.href = '/';
            }
        }
    }

    showLoginSection() {
        document.getElementById('login-section')?.classList.remove('hidden');
        document.getElementById('profile-section')?.classList.add('hidden');
        document.getElementById('user-info')?.classList.add('hidden');
        this.clearIntervals();
    }
    async checkCustomUrl(url) {
        try {
            const response = await fetch(`${config.backendUrl}/users/check-url/${url}`);
            if (!response.ok) throw new Error('Failed to check URL availability');
            return await response.json();
        } catch (error) {
            console.error('Failed to check URL availability:', error);
            return { available: false, reason: 'Error checking URL availability' };
        }
    }
    
    async updateCustomUrl(userId, newUrl) {
        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}/custom-url`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newUrl)  // Send the URL string directly
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to update URL');
            }
            
            const result = await response.json();
            return result;
        } catch (error) {
            console.error('Failed to update custom URL:', error);
            throw error.message || 'Failed to update URL';
        }
    }

    async showProfileSection(userData, isOwnProfile) {
        document.getElementById('login-section')?.classList.add('hidden');
        document.getElementById('profile-section')?.classList.remove('hidden');
        
        const loggedInUserId = localStorage.getItem('spotify_user_id');
        if (loggedInUserId) {
            const userInfo = document.getElementById('user-info');
            userInfo?.classList.remove('hidden');
            
            if (!isOwnProfile) {
                try {
                    const response = await fetch(`${config.backendUrl}/users/${loggedInUserId}`);
                    if (response.ok) {
                        const loggedInUserData = await response.json();
                        this.updateUserInfo(loggedInUserData);
                    }
                } catch (error) {
                    console.error('Failed to fetch logged-in user data:', error);
                }
            } else {
                this.updateUserInfo(userData);
            }
        }

        // Remove any existing URL container before adding a new one
        const existingUrlContainer = document.querySelector('.profile-url-container');
        if (existingUrlContainer) {
            existingUrlContainer.remove();
        }

        if (isOwnProfile) {
            const urlContainer = document.createElement('div');
            urlContainer.className = 'profile-url-container';
            urlContainer.innerHTML = `
                <div class="profile-url-display">
                    <span class="url-prefix">versz.fun/</span>
                    <span class="current-url">${userData.custom_url || userData.id}</span>
                    <button class="edit-url-btn">
                        <i class="fas fa-pencil-alt"></i>
                    </button>
                </div>
                <div class="url-editor hidden">
                    <input type="text" class="url-input" 
                        placeholder="Enter custom URL"
                        value="${userData.custom_url || userData.id}">
                    <div class="url-feedback"></div>
                    <div class="url-buttons">
                        <button class="save-url-btn">Save</button>
                        <button class="cancel-url-btn">Cancel</button>
                    </div>
                </div>
            `;
            
            document.querySelector('.profile-info').appendChild(urlContainer);
            
            // Add event listeners for URL editing
            const editBtn = urlContainer.querySelector('.edit-url-btn');
            const urlEditor = urlContainer.querySelector('.url-editor');
            const urlInput = urlContainer.querySelector('.url-input');
            const urlFeedback = urlContainer.querySelector('.url-feedback');
            const saveBtn = urlContainer.querySelector('.save-url-btn');
            const cancelBtn = urlContainer.querySelector('.cancel-url-btn');
            
            editBtn.addEventListener('click', () => {
                urlEditor.classList.remove('hidden');
                urlInput.focus();
            });
            
            cancelBtn.addEventListener('click', () => {
                urlEditor.classList.add('hidden');
                urlInput.value = userData.custom_url || userData.id;
                urlFeedback.textContent = '';
            });
            
            let checkTimeout;
            urlInput.addEventListener('input', () => {
                clearTimeout(checkTimeout);
                const value = urlInput.value.trim();
                
                if (!value) {
                    urlFeedback.textContent = 'URL cannot be empty';
                    urlFeedback.className = 'url-feedback unavailable';
                    saveBtn.disabled = true;
                    return;
                }
                
                checkTimeout = setTimeout(async () => {
                    if (value === (userData.custom_url || userData.id)) {
                        urlFeedback.textContent = '';
                        saveBtn.disabled = true;
                        return;
                    }
                    
                    try {
                        const result = await this.checkCustomUrl(value);
                        if (result.available) {
                            urlFeedback.textContent = '✓ URL is available';
                            urlFeedback.className = 'url-feedback available';
                            saveBtn.disabled = false;
                        } else {
                            urlFeedback.textContent = `✗ ${result.reason || 'URL is not available'}`;
                            urlFeedback.className = 'url-feedback unavailable';
                            saveBtn.disabled = true;
                        }
                    } catch (error) {
                        urlFeedback.textContent = '✗ Error checking URL availability';
                        urlFeedback.className = 'url-feedback unavailable';
                        saveBtn.disabled = true;
                    }
                }, 300);
            });
            
            saveBtn.addEventListener('click', async () => {
                const newUrl = urlInput.value.trim();
                try {
                    const result = await this.updateCustomUrl(userData.id, newUrl);
                    if (result.success) {
                        userData.custom_url = result.custom_url;
                        urlEditor.classList.add('hidden');
                        document.querySelector('.current-url').textContent = result.custom_url;
                        this.showSuccess('Profile URL updated successfully');
                        
                        if (window.location.pathname === `/${userData.id}`) {
                            history.replaceState({}, '', `/${result.custom_url}`);
                        }
                    }
                } catch (error) {
                    this.showError(error);
                }
            });
        }

        this.updateProfileInfo(userData);
        await this.startTracking(userData.id);
        
        // Show Recent Tracks tab by default
        this.switchTab('recent-tracks');
    }

    updateUserInfo(userData) {
        const username = document.getElementById('username');
        const userAvatar = document.getElementById('user-avatar');
        const profileLink = document.getElementById('profile-link');
        
        if (username) username.textContent = userData.display_name || userData.id;
        if (userAvatar) userAvatar.src = userData.avatar_url || '/api/placeholder/32/32';
        if (profileLink) profileLink.href = `/${userData.id}`;
    }

    updateProfileInfo(userData) {
        const profileUsername = document.getElementById('profile-username');
        const profileAvatar = document.getElementById('profile-avatar');
        
        if (profileUsername) profileUsername.textContent = userData.display_name || userData.id;
        if (profileAvatar) profileAvatar.src = userData.avatar_url || '/api/placeholder/96/96';
        document.title = `${userData.display_name || userData.id} - versz`;
    }

    async startTracking(userId) {
        this.clearIntervals();
        
        await Promise.all([
            this.updateCurrentTrack(userId),
            this.updateRecentTracks(userId),
            this.updateTopTracks(userId),
            this.updateTopArtists(userId)
        ]);
        
        this.currentTrackInterval = setInterval(() => this.updateCurrentTrack(userId), 30000);
        this.recentTracksInterval = setInterval(() => this.updateRecentTracks(userId), 60000);
    }

    async updateCurrentTrack(userId) {
        const currentTrackInfo = document.getElementById('current-track-info');
        if (!currentTrackInfo) return;
        
        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}/currently-playing`);
            if (!response.ok) throw new Error('Failed to fetch current track');
            
            const data = await response.json();
            
            if (data.is_playing) {
                currentTrackInfo.innerHTML = `
                    <div class="track-info">
                        <img src="${data.album_art || '/api/placeholder/64/64'}" 
                             alt="Album Art" 
                             class="track-artwork"
                             onerror="this.src='/api/placeholder/64/64'">
                        <div class="track-details">
                            <div class="track-name">${this.escapeHtml(data.track_name)}</div>
                            <div class="track-artist">${this.escapeHtml(data.artist_name)}</div>
                        </div>
                    </div>
                `;
                currentTrackInfo.classList.add('playing');
            } else {
                currentTrackInfo.innerHTML = `
                    <div class="placeholder-text">
                        <i class="fas fa-music"></i>
                        Not playing anything right now
                    </div>
                `;
                currentTrackInfo.classList.remove('playing');
            }
        } catch (error) {
            console.error('Failed to update current track:', error);
            currentTrackInfo.innerHTML = `
                <div class="placeholder-text">
                    <i class="fas fa-exclamation-circle"></i>
                    Unable to fetch current track
                </div>
            `;
        }
    }

    async updateRecentTracks(userId) {
        const tracksList = document.getElementById('tracks-list');
        const tracksCount = document.getElementById('tracks-count');
        
        if (!tracksList || !tracksCount) return;
        
        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}/recent-tracks`);
            if (!response.ok) {
                throw new Error(`Failed to fetch recent tracks: ${response.status}`);
            }
            
            const tracks = await response.json();
            
            if (!Array.isArray(tracks)) {
                throw new Error('Invalid response format for recent tracks');
            }
            
            this.dataCache.recentTracks = tracks;
            
            if (tracks.length === 0) {
                tracksList.innerHTML = `
                    <div class="placeholder-text">
                        <i class="fas fa-music"></i>
                        No recent tracks found
                    </div>
                `;
                tracksCount.textContent = '0';
                return;
            }
            
            tracksCount.textContent = tracks.length;
            
            tracksList.innerHTML = tracks.map(track => `
                <div class="track-item">
                    <img src="${track.album_art || '/api/placeholder/48/48'}" 
                         alt="Album Art" 
                         class="track-artwork"
                         onerror="this.src='/api/placeholder/48/48'">
                    <div class="track-details">
                        <div class="track-name">${this.escapeHtml(track.track_name)}</div>
                        <div class="track-artist">${this.escapeHtml(track.artist_name)}</div>
                        <div class="track-time">${this.formatDate(track.played_at)}</div>
                    </div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Failed to update recent tracks:', error);
            tracksList.innerHTML = `
                <div class="placeholder-text">
                    <i class="fas fa-exclamation-circle"></i>
                    Unable to fetch recent tracks: ${error.message}
                </div>
            `;
            tracksCount.textContent = '0';
        }
    }

    async updateTopTracks(userId) {
        const topTracksList = document.getElementById('top-tracks-list');
        const topTracksCount = document.getElementById('top-tracks-count');
        
        if (!topTracksList || !topTracksCount) return;
        
        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}/top-tracks`);
            if (!response.ok) throw new Error('Failed to fetch top tracks');
            
            const tracks = await response.json();
            this.dataCache.topTracks = tracks;
            
            topTracksCount.textContent = tracks.length;
            
            topTracksList.innerHTML = tracks.map((track, index) => `
                <div class="track-item">
                    <div class="track-rank">${index + 1}</div>
                    <img src="${track.album_art || '/api/placeholder/48/48'}" 
                         alt="Album Art" 
                         class="track-artwork"
                         onerror="this.src='/api/placeholder/48/48'">
                    <div class="track-details">
                        <div class="track-name">${this.escapeHtml(track.track_name)}</div>
                        <div class="track-artist">${this.escapeHtml(track.artist_name)}</div>
                        <div class="track-popularity">Popularity: ${track.popularity}%</div>
                    </div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Failed to update top tracks:', error);
            topTracksList.innerHTML = `
                <div class="placeholder-text">
                    <i class="fas fa-exclamation-circle"></i>
                    Unable to fetch top tracks
                </div>
            `;
            topTracksCount.textContent = '0';
        }
    }

    async updateTopArtists(userId) {
        const topArtistsList = document.getElementById('top-artists-list');
        const topArtistsCount = document.getElementById('top-artists-count');
        
        if (!topArtistsList || !topArtistsCount) return;
        
        try {
            const response = await fetch(`${config.backendUrl}/users/${userId}/top-artists`);
            if (!response.ok) throw new Error('Failed to fetch top artists');
            
            const artists = await response.json();
            this.dataCache.topArtists = artists;
            
            topArtistsCount.textContent = artists.length;
            
            topArtistsList.innerHTML = artists.map((artist, index) => `
                <div class="artist-item">
                    <div class="artist-rank">${index + 1}</div>
                    <img src="${artist.artist_image || '/api/placeholder/64/64'}" 
                         alt="Artist" 
                         class="artist-artwork"
                         onerror="this.src='/api/placeholder/64/64'">
                    <div class="artist-details">
                        <div class="artist-name">${this.escapeHtml(artist.artist_name)}</div>
                        <div class="artist-popularity">Popularity: ${artist.popularity}%</div>
                    </div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Failed to update top artists:', error);
            topArtistsList.innerHTML = `
                <div class="placeholder-text">
                    <i class="fas fa-exclamation-circle"></i>
                    Unable to fetch top artists
                </div>
            `;
            topArtistsCount.textContent = '0';
        }
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = Math.floor((now - date) / 1000);
        
        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
        return date.toLocaleDateString();
    }

    showError(message) {
        const errorContainer = document.createElement('div');
        errorContainer.className = 'error-message animate__animated animate__fadeIn';
        errorContainer.textContent = message;
        
        const container = document.getElementById('error-container');
        if (container) {
            container.appendChild(errorContainer);
            
            setTimeout(() => {
                errorContainer.classList.add('animate__fadeOut');
                setTimeout(() => errorContainer.remove(), 300);
            }, 5000);
        }
    }
}

// Initialize the app when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    new VerszApp();
});
