// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Sketch Arena: The Panic Archive
/// @notice One permanent ERC-721 collection for player-created Sketch Arena trophies.
/// @dev The game backend authorizes narrowly scoped mints with EIP-712 vouchers. Promo codes,
///      achievements, Battle Pass rewards, discounts and Mint Credits are resolved off-chain
///      before signing; the contract enforces the final recipient, WSHIDO amount and provenance.
///      Each token's ERC-2981 royalty belongs permanently to its original minting wallet.
contract SketchArenaPanicArchive is ERC721URIStorage, ERC2981, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    uint96 public constant MAX_ROYALTY_BPS = 1_000;
    bytes32 public constant MINT_VOUCHER_TYPEHASH = keccak256(
        "MintVoucher(address recipient,bytes32 tokenURIHash,bytes32 artworkHash,uint256 price,uint256 nonce,uint256 deadline,uint32 seasonId,bytes32 campaignId)"
    );

    struct MintVoucher {
        address recipient;
        bytes32 tokenURIHash;
        bytes32 artworkHash;
        uint256 price;
        uint256 nonce;
        uint256 deadline;
        uint32 seasonId;
        bytes32 campaignId;
    }

    error InvalidOwner();
    error InvalidSigner();
    error InvalidRecipient();
    error InvalidPayoutReceiver();
    error InvalidPaymentToken();
    error InvalidSupply();
    error EmptyTokenURI();
    error EmptyArtworkHash();
    error VoucherExpired();
    error VoucherAlreadyUsed();
    error VoucherRevoked();
    error InvalidVoucherSigner();
    error TokenURIHashMismatch();
    error ArtworkAlreadyMinted();
    error PriceAboveSafetyCap();
    error MaxSupplyReached();
    error RecipientBlocked();
    error RecipientNotApproved();
    error RoyaltyTooHigh();
    error CollectionMetadataFrozen();
    error EmptyCollectionURI();

    uint256 public immutable maxSupply;
    IERC20 public immutable paymentToken;
    uint96 public immutable artistRoyaltyBps;
    uint256 public nextTokenId = 1;
    address public mintSigner;
    address public payoutReceiver;
    uint256 public maxMintPrice;
    bool public allowlistRequired;
    bool public collectionMetadataFrozen;

    mapping(uint256 => bool) public usedNonces;
    mapping(uint256 => bool) public revokedNonces;
    mapping(bytes32 => uint256) public tokenIdByArtworkHash;
    mapping(address => bool) public blockedRecipients;
    mapping(address => bool) public approvedRecipients;

    string private _collectionMetadataURI;

    event PanicArchiveMinted(
        address indexed recipient,
        uint256 indexed tokenId,
        bytes32 indexed artworkHash,
        uint256 pricePaid,
        uint256 nonce,
        uint32 seasonId,
        bytes32 campaignId
    );
    event MintSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event PayoutReceiverUpdated(address indexed previousReceiver, address indexed newReceiver);
    event MaxMintPriceUpdated(uint256 previousPrice, uint256 newPrice);
    event VoucherNonceRevoked(uint256 indexed nonce);
    event RecipientBlockUpdated(address indexed recipient, bool blocked);
    event RecipientApprovalUpdated(address indexed recipient, bool approved);
    event AllowlistRequirementUpdated(bool required);
    event CollectionMetadataUpdated(string contractURI);
    event CollectionMetadataLocked(string contractURI);
    event MintingPaused(address indexed operator);
    event MintingResumed(address indexed operator);

    constructor(
        address owner_,
        address mintSigner_,
        address payoutReceiver_,
        address paymentToken_,
        uint256 maxSupply_,
        uint256 maxMintPrice_,
        string memory collectionMetadataURI_,
        uint96 artistRoyaltyBps_
    ) ERC721("Sketch Arena: The Panic Archive", "PANIC") EIP712("Sketch Arena: The Panic Archive", "1") {
        if (owner_ == address(0)) revert InvalidOwner();
        if (mintSigner_ == address(0)) revert InvalidSigner();
        if (payoutReceiver_ == address(0)) revert InvalidPayoutReceiver();
        if (paymentToken_ == address(0) || paymentToken_.code.length == 0) revert InvalidPaymentToken();
        if (maxSupply_ == 0) revert InvalidSupply();
        if (bytes(collectionMetadataURI_).length == 0) revert EmptyCollectionURI();
        if (artistRoyaltyBps_ > MAX_ROYALTY_BPS) revert RoyaltyTooHigh();

        _transferOwnership(owner_);
        mintSigner = mintSigner_;
        payoutReceiver = payoutReceiver_;
        paymentToken = IERC20(paymentToken_);
        maxSupply = maxSupply_;
        maxMintPrice = maxMintPrice_;
        artistRoyaltyBps = artistRoyaltyBps_;
        _collectionMetadataURI = collectionMetadataURI_;
        // Mainnet deployments begin fail-closed. The owner must explicitly
        // unpause after reviewing the deployed bytecode and constructor state.
        _pause();
    }

    function contractURI() external view returns (string memory) {
        return _collectionMetadataURI;
    }

    function totalMinted() external view returns (uint256) {
        return nextTokenId - 1;
    }

    function voucherDigest(MintVoucher calldata voucher) external view returns (bytes32) {
        return _hashTypedDataV4(_voucherStructHash(voucher));
    }

    function redeem(MintVoucher calldata voucher, string calldata tokenURI_, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (voucher.recipient == address(0) || msg.sender != voucher.recipient) revert InvalidRecipient();
        if (blockedRecipients[voucher.recipient]) revert RecipientBlocked();
        if (allowlistRequired && !approvedRecipients[voucher.recipient]) revert RecipientNotApproved();
        if (voucher.deadline < block.timestamp) revert VoucherExpired();
        if (usedNonces[voucher.nonce]) revert VoucherAlreadyUsed();
        if (revokedNonces[voucher.nonce]) revert VoucherRevoked();
        if (bytes(tokenURI_).length == 0) revert EmptyTokenURI();
        if (keccak256(bytes(tokenURI_)) != voucher.tokenURIHash) revert TokenURIHashMismatch();
        if (voucher.artworkHash == bytes32(0)) revert EmptyArtworkHash();
        if (tokenIdByArtworkHash[voucher.artworkHash] != 0) revert ArtworkAlreadyMinted();
        if (voucher.price > maxMintPrice) revert PriceAboveSafetyCap();
        if (nextTokenId > maxSupply) revert MaxSupplyReached();

        address recovered = ECDSA.recover(_hashTypedDataV4(_voucherStructHash(voucher)), signature);
        if (recovered != mintSigner) revert InvalidVoucherSigner();

        usedNonces[voucher.nonce] = true;
        if (voucher.price != 0) paymentToken.safeTransferFrom(voucher.recipient, payoutReceiver, voucher.price);
        tokenId = nextTokenId++;
        tokenIdByArtworkHash[voucher.artworkHash] = tokenId;
        _safeMint(voucher.recipient, tokenId);
        _setTokenURI(tokenId, tokenURI_);
        if (artistRoyaltyBps != 0) _setTokenRoyalty(tokenId, voucher.recipient, artistRoyaltyBps);

        emit PanicArchiveMinted(
            voucher.recipient,
            tokenId,
            voucher.artworkHash,
            voucher.price,
            voucher.nonce,
            voucher.seasonId,
            voucher.campaignId
        );
    }

    function setMintSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidSigner();
        address previous = mintSigner;
        mintSigner = newSigner;
        emit MintSignerUpdated(previous, newSigner);
    }

    function revokeVoucherNonce(uint256 nonce) external onlyOwner {
        if (usedNonces[nonce]) revert VoucherAlreadyUsed();
        revokedNonces[nonce] = true;
        emit VoucherNonceRevoked(nonce);
    }

    function setRecipientBlocked(address recipient, bool blocked) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();
        blockedRecipients[recipient] = blocked;
        emit RecipientBlockUpdated(recipient, blocked);
    }

    function setRecipientApproved(address recipient, bool approved) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();
        approvedRecipients[recipient] = approved;
        emit RecipientApprovalUpdated(recipient, approved);
    }

    function setAllowlistRequired(bool required) external onlyOwner {
        allowlistRequired = required;
        emit AllowlistRequirementUpdated(required);
    }

    function setMaxMintPrice(uint256 newMaxMintPrice) external onlyOwner {
        uint256 previous = maxMintPrice;
        maxMintPrice = newMaxMintPrice;
        emit MaxMintPriceUpdated(previous, newMaxMintPrice);
    }

    function setPayoutReceiver(address newReceiver) external onlyOwner {
        if (newReceiver == address(0)) revert InvalidPayoutReceiver();
        address previous = payoutReceiver;
        payoutReceiver = newReceiver;
        emit PayoutReceiverUpdated(previous, newReceiver);
    }

    function setCollectionMetadataURI(string calldata newURI) external onlyOwner {
        if (collectionMetadataFrozen) revert CollectionMetadataFrozen();
        if (bytes(newURI).length == 0) revert EmptyCollectionURI();
        _collectionMetadataURI = newURI;
        emit CollectionMetadataUpdated(newURI);
    }

    function freezeCollectionMetadata() external onlyOwner {
        if (collectionMetadataFrozen) revert CollectionMetadataFrozen();
        collectionMetadataFrozen = true;
        emit CollectionMetadataLocked(_collectionMetadataURI);
    }

    function pause() external onlyOwner {
        _pause();
        emit MintingPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit MintingResumed(msg.sender);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _voucherStructHash(MintVoucher calldata voucher) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MINT_VOUCHER_TYPEHASH,
                voucher.recipient,
                voucher.tokenURIHash,
                voucher.artworkHash,
                voucher.price,
                voucher.nonce,
                voucher.deadline,
                voucher.seasonId,
                voucher.campaignId
            )
        );
    }
}
